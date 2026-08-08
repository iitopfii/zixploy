/**
 * เปลี่ยนรหัสผ่าน — POST /api/v1/auth/change-password
 *
 * เน้นคุณสมบัติความปลอดภัยที่ถ้าพลาดแล้วบัญชีถูกยึด:
 * - ต้องยืนยันรหัสผ่านเดิม (session ที่ถูกขโมยเปลี่ยนรหัสผ่านไม่ได้)
 * - รหัสผ่านเก่าใช้ login ไม่ได้อีก, รหัสใหม่ใช้ได้
 * - session อื่นถูก revoke ทั้งหมด แต่เครื่องที่เปลี่ยนยังใช้งานต่อได้
 * - เดารหัสผ่านเดิมผิดซ้ำ ๆ ติด rate limit เหมือน login
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { json } from "./helpers";

const OLD_PASS = "original-password-123";
const NEW_PASS = "brand-new-password-456";

function parseCookies(res: Response) {
  const jar: Record<string, string> = {};
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (pair && eq > 0) jar[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  return jar;
}

function toHeader(jar: Record<string, string>) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
}

async function setup() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));

  const now = Date.now();
  const userId = ulid();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)",
  ).run(userId, await hashPassword(OLD_PASS), now, now);

  const app = buildApp(db);
  return { db, app, userId };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function login(ctx: Ctx, password = OLD_PASS) {
  const res = await ctx.app.handle(
    new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password }),
    }),
  );
  const jar = parseCookies(res);
  return { res, jar, cookie: toHeader(jar), csrf: jar.zx_csrf ?? "" };
}

function changePassword(
  ctx: Ctx,
  auth: { cookie: string; csrf: string },
  currentPassword: string,
  newPassword: string,
) {
  return ctx.app.handle(
    new Request("http://localhost/api/v1/auth/change-password", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: auth.cookie,
        "x-csrf-token": auth.csrf,
      },
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  );
}

function getSession(ctx: Ctx, cookie: string) {
  return ctx.app.handle(
    new Request("http://localhost/api/v1/auth/session", { headers: { cookie } }),
  );
}

// ---------------------------------------------------------------------------

describe("เปลี่ยนรหัสผ่านสำเร็จ", () => {
  test("คืน 200 พร้อม session ที่ยังใช้งานได้", async () => {
    const ctx = await setup();
    const auth = await login(ctx);

    const res = await changePassword(ctx, auth, OLD_PASS, NEW_PASS);
    expect(res.status).toBe(200);
    expect((await json(res)).authenticated).toBe(true);
  });

  test("รหัสผ่านเก่าใช้ login ไม่ได้อีก", async () => {
    const ctx = await setup();
    const auth = await login(ctx);
    await changePassword(ctx, auth, OLD_PASS, NEW_PASS);

    const retry = await login(ctx, OLD_PASS);
    expect(retry.res.status).toBe(401);
  });

  test("รหัสผ่านใหม่ใช้ login ได้", async () => {
    const ctx = await setup();
    const auth = await login(ctx);
    await changePassword(ctx, auth, OLD_PASS, NEW_PASS);

    const retry = await login(ctx, NEW_PASS);
    expect(retry.res.status).toBe(200);
  });

  test("hash ใน DB เปลี่ยนจริงและไม่ใช่ plaintext", async () => {
    const ctx = await setup();
    const auth = await login(ctx);
    await changePassword(ctx, auth, OLD_PASS, NEW_PASS);

    const row = ctx.db
      .query<{ password_hash: string }, [string]>("SELECT password_hash FROM users WHERE id = ?")
      .get(ctx.userId);
    expect(row?.password_hash).not.toContain(NEW_PASS);
    expect(row?.password_hash).not.toContain(OLD_PASS);
  });
});

describe("session หลังเปลี่ยนรหัสผ่าน", () => {
  test("session อื่นถูก revoke — ผู้บุกรุกที่ค้างอยู่หลุดออกไป", async () => {
    const ctx = await setup();
    const attacker = await login(ctx); // session ที่ถูกขโมย (login ไว้ก่อน)
    const owner = await login(ctx);

    await changePassword(ctx, owner, OLD_PASS, NEW_PASS);

    const stillIn = await json(await getSession(ctx, attacker.cookie));
    expect(stillIn.authenticated).toBe(false);
  });

  test("เครื่องที่เปลี่ยนรหัสผ่านยังใช้งานต่อได้ด้วย cookie ใหม่", async () => {
    const ctx = await setup();
    const auth = await login(ctx);

    const res = await changePassword(ctx, auth, OLD_PASS, NEW_PASS);
    const fresh = toHeader(parseCookies(res));

    const after = await json(await getSession(ctx, fresh));
    expect(after.authenticated).toBe(true);
    expect(after.username).toBe("admin");
  });

  test("session ใหม่ต่างจากอันเดิม (ไม่ใช่แค่ต่ออายุของเก่า)", async () => {
    const ctx = await setup();
    const auth = await login(ctx);

    const res = await changePassword(ctx, auth, OLD_PASS, NEW_PASS);
    const freshJar = parseCookies(res);
    expect(freshJar.zx_session).toBeDefined();
    expect(freshJar.zx_session).not.toBe(auth.jar.zx_session);
  });
});

describe("การป้องกัน", () => {
  test("รหัสผ่านเดิมผิด → 401 และรหัสผ่านไม่ถูกเปลี่ยน", async () => {
    const ctx = await setup();
    const auth = await login(ctx);

    const res = await changePassword(ctx, auth, "wrong-password-xx", NEW_PASS);
    expect(res.status).toBe(401);

    // ยังเข้าด้วยรหัสเดิมได้ = ไม่ถูกเปลี่ยน
    expect((await login(ctx, OLD_PASS)).res.status).toBe(200);
  });

  test("ไม่ login → 401", async () => {
    const ctx = await setup();
    const res = await ctx.app.handle(
      new Request("http://localhost/api/v1/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: OLD_PASS, newPassword: NEW_PASS }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("ไม่มี CSRF token → ถูกปฏิเสธ", async () => {
    const ctx = await setup();
    const auth = await login(ctx);

    const res = await ctx.app.handle(
      new Request("http://localhost/api/v1/auth/change-password", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: auth.cookie },
        body: JSON.stringify({ currentPassword: OLD_PASS, newPassword: NEW_PASS }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("รหัสผ่านใหม่สั้นเกินไป → 400", async () => {
    const ctx = await setup();
    const auth = await login(ctx);

    const res = await changePassword(ctx, auth, OLD_PASS, "sh0rt");
    expect(res.status).toBe(400);
  });

  test("รหัสผ่านใหม่ซ้ำกับเดิม → 400", async () => {
    const ctx = await setup();
    const auth = await login(ctx);

    const res = await changePassword(ctx, auth, OLD_PASS, OLD_PASS);
    expect(res.status).toBe(400);
  });

  test("เดารหัสผ่านเดิมผิดซ้ำ ๆ ติด rate limit เหมือน login", async () => {
    const ctx = await setup();
    const auth = await login(ctx);

    let limited = false;
    for (let i = 0; i < 12; i++) {
      const res = await changePassword(ctx, auth, `wrong-${i}-padding`, NEW_PASS);
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });

  test("บันทึก audit event ทั้งตอนสำเร็จและตอนรหัสผ่านเดิมผิด", async () => {
    const ctx = await setup();
    const auth = await login(ctx);

    await changePassword(ctx, auth, "wrong-password-xx", NEW_PASS);
    await changePassword(ctx, auth, OLD_PASS, NEW_PASS);

    const actions = ctx.db
      .query<{ action: string }, []>("SELECT action FROM audit_events")
      .all()
      .map((r) => r.action);
    expect(actions).toContain("password_change_failed");
    expect(actions).toContain("password_changed");
  });
});
