import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { hashPassword, verifyPassword } from "../src/auth/password";
import {
  clearFailedLogins,
  failedLoginCount,
  isLoginRateLimited,
  LOGIN_LIMIT,
  recordFailedLogin,
} from "../src/auth/rate-limit";
import {
  createSession,
  csrfTokensMatch,
  findActiveSession,
  hashToken,
  purgeExpiredSessions,
  revokeAllSessions,
  revokeSession,
  SESSION_TTL_MS,
} from "../src/auth/session";

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function makeUser(db: ReturnType<typeof makeDb>, hash = "x") {
  const id = ulid();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, `admin-${id}`, hash, Date.now(), Date.now());
  return id;
}

describe("password hashing", () => {
  test("hash เป็น Argon2id และ verify ถูก/ผิดได้", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toStartWith("$argon2id$");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password here", hash)).toBe(false);
  });

  test("hash เดียวกันสองครั้งได้ค่าต่างกัน (มี salt)", async () => {
    const a = await hashPassword("correct horse battery staple");
    const b = await hashPassword("correct horse battery staple");
    expect(a).not.toBe(b);
  });

  test("ปฏิเสธ password สั้นเกินไป", async () => {
    expect(hashPassword("short")).rejects.toThrow(/at least/);
  });

  test("verify ไม่โยน error เมื่อ hash เสียหาย", async () => {
    expect(await verifyPassword("anything at all", "not-a-hash")).toBe(false);
  });
});

describe("sessions", () => {
  test("DB เก็บเฉพาะ hash ของ token ไม่เก็บ token จริง", () => {
    const db = makeDb();
    const userId = makeUser(db);
    const { token } = createSession(db, userId);

    const stored = db.query<{ id: string }, []>("SELECT id FROM sessions").all();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(hashToken(token));
    expect(stored[0]?.id).not.toBe(token);
  });

  test("หา session ที่ใช้งานได้จาก token", () => {
    const db = makeDb();
    const userId = makeUser(db);
    const { token } = createSession(db, userId);

    const active = findActiveSession(db, token);
    expect(active?.userId).toBe(userId);
    expect(findActiveSession(db, "some-other-token")).toBeNull();
  });

  test("session ที่หมดอายุใช้ไม่ได้", () => {
    const db = makeDb();
    const userId = makeUser(db);
    const now = Date.now();
    const { token } = createSession(db, userId, now);

    expect(findActiveSession(db, token, now + SESSION_TTL_MS - 1000)).not.toBeNull();
    expect(findActiveSession(db, token, now + SESSION_TTL_MS + 1000)).toBeNull();
  });

  test("revoke ทำให้ session ใช้ไม่ได้ทันที", () => {
    const db = makeDb();
    const userId = makeUser(db);
    const { token } = createSession(db, userId);

    revokeSession(db, token);
    expect(findActiveSession(db, token)).toBeNull();
  });

  test("revoke all ปิดทุก session ของ user", () => {
    const db = makeDb();
    const userId = makeUser(db);
    const a = createSession(db, userId);
    const b = createSession(db, userId);

    expect(revokeAllSessions(db, userId)).toBe(2);
    expect(findActiveSession(db, a.token)).toBeNull();
    expect(findActiveSession(db, b.token)).toBeNull();
  });

  test("purge ลบเฉพาะ session ที่หมดอายุ", () => {
    const db = makeDb();
    const userId = makeUser(db);
    const now = Date.now();
    createSession(db, userId, now - SESSION_TTL_MS - 1000); // หมดอายุแล้ว
    const fresh = createSession(db, userId, now);

    expect(purgeExpiredSessions(db, now)).toBe(1);
    expect(findActiveSession(db, fresh.token, now)).not.toBeNull();
  });

  test("ลบ user แล้ว session ถูกลบตาม (foreign key cascade)", () => {
    const db = makeDb();
    const userId = makeUser(db);
    createSession(db, userId);

    db.query("DELETE FROM users WHERE id = ?").run(userId);
    expect(db.query<{ n: number }, []>("SELECT count(*) as n FROM sessions").get()?.n).toBe(0);
  });
});

describe("CSRF double-submit", () => {
  test("ตรงกันเท่านั้นจึงผ่าน", () => {
    expect(csrfTokensMatch("abc123", "abc123")).toBe(true);
    expect(csrfTokensMatch("abc123", "abc124")).toBe(false);
    expect(csrfTokensMatch("abc123", "abc1234")).toBe(false);
  });

  test("ค่าที่หายไปถือว่าไม่ผ่าน", () => {
    expect(csrfTokensMatch(undefined, "abc123")).toBe(false);
    expect(csrfTokensMatch("abc123", null)).toBe(false);
    expect(csrfTokensMatch(undefined, null)).toBe(false);
    expect(csrfTokensMatch("", "")).toBe(false);
  });
});

describe("login rate limit", () => {
  test("บล็อกเมื่อถึงจำนวนครั้งที่กำหนด", () => {
    const db = makeDb();
    for (let i = 0; i < LOGIN_LIMIT.maxAttempts - 1; i++) {
      recordFailedLogin(db, "admin", "ip:1.2.3.4");
    }
    expect(isLoginRateLimited(db, "ip:1.2.3.4")).toBe(false);

    recordFailedLogin(db, "admin", "ip:1.2.3.4");
    expect(isLoginRateLimited(db, "ip:1.2.3.4")).toBe(true);
  });

  test("นับเฉพาะในหน้าต่างเวลาและเฉพาะ client เดียวกัน", () => {
    const db = makeDb();
    const now = Date.now();
    recordFailedLogin(db, "admin", "ip:1.1.1.1", now - LOGIN_LIMIT.windowMs - 1000);
    recordFailedLogin(db, "admin", "ip:1.1.1.1", now);
    recordFailedLogin(db, "admin", "ip:9.9.9.9", now);

    expect(failedLoginCount(db, "ip:1.1.1.1", now)).toBe(1);
    expect(failedLoginCount(db, "ip:9.9.9.9", now)).toBe(1);
  });

  test("login สำเร็จล้างประวัติของ client นั้น", () => {
    const db = makeDb();
    recordFailedLogin(db, "admin", "ip:1.2.3.4");
    clearFailedLogins(db, "ip:1.2.3.4");
    expect(failedLoginCount(db, "ip:1.2.3.4")).toBe(0);
  });

  test("ไม่เก็บ password ที่ลองผิดลงตาราง", () => {
    const db = makeDb();
    recordFailedLogin(db, "admin", "ip:1.2.3.4");
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(login_attempts)")
      .all()
      .map((c) => c.name);
    expect(columns).toEqual(["id", "username", "client_key", "attempted_at"]);
  });
});
