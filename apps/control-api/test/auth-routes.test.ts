import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { LOGIN_LIMIT } from "../src/auth/rate-limit";
import { json } from "./helpers";

const PASSWORD = "correct horse battery staple";

async function makeApp() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(ulid(), "admin", await hashPassword(PASSWORD), now, now);
  return { db, app: buildApp(db) };
}

/** ดึงคุกกี้จาก Set-Cookie ทั้งหมดเป็น map ชื่อ -> ค่า */
function parseCookies(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (pair && eq > 0) out[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  return out;
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
}

async function login(app: Awaited<ReturnType<typeof makeApp>>["app"], password = PASSWORD) {
  const res = await app.handle(
    new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password }),
    }),
  );
  return { res, cookies: parseCookies(res) };
}

describe("POST /auth/login", () => {
  test("credentials ถูกต้อง -> ได้ session cookie (httpOnly) และ csrf cookie (อ่านได้จาก JS)", async () => {
    const { app } = await makeApp();
    const res = await app.handle(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: PASSWORD }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ authenticated: true, username: "admin" });

    const setCookies = res.headers.getSetCookie().join("\n");
    expect(setCookies).toContain("zx_session=");
    expect(setCookies).toContain("HttpOnly");
    const csrfLine = res.headers.getSetCookie().find((c) => c.startsWith("zx_csrf="));
    expect(csrfLine).toBeDefined();
    expect(csrfLine).not.toContain("HttpOnly");
  });

  test("password ผิดและ username ไม่มี ตอบ code เดียวกัน (กัน username enumeration)", async () => {
    const { app } = await makeApp();

    const wrongPassword = await app.handle(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "definitely wrong pw" }),
      }),
    );
    const noSuchUser = await app.handle(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "ghost", password: PASSWORD }),
      }),
    );

    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    const a = await json(wrongPassword);
    const b = await json(noSuchUser);
    expect(a.error.code).toBe("INVALID_CREDENTIALS");
    expect(b.error.code).toBe(a.error.code);
    expect(b.error.message).toBe(a.error.message);
  });

  test("login ล้มเหลวไม่ตั้ง session cookie", async () => {
    const { app } = await makeApp();
    const { cookies } = await login(app, "definitely wrong pw");
    expect(cookies.zx_session).toBeUndefined();
  });

  test("ผิดซ้ำเกินลิมิตแล้วโดน rate limit", async () => {
    const { app } = await makeApp();
    for (let i = 0; i < LOGIN_LIMIT.maxAttempts; i++) {
      await login(app, "definitely wrong pw");
    }
    // แม้ password ถูกก็ต้องโดนบล็อกในหน้าต่างเวลานี้
    const { res } = await login(app);
    expect(res.status).toBe(429);
    expect((await json(res)).error.code).toBe("RATE_LIMITED");
  });

  test("login สำเร็จล้างประวัติ failed attempts", async () => {
    const { db, app } = await makeApp();
    for (let i = 0; i < LOGIN_LIMIT.maxAttempts - 1; i++) {
      await login(app, "definitely wrong pw");
    }
    await login(app);
    expect(db.query<{ n: number }, []>("SELECT count(*) as n FROM login_attempts").get()?.n).toBe(
      0,
    );
  });

  test("body ไม่ถูก schema ถูกปฏิเสธ", async () => {
    const { app } = await makeApp();
    const res = await app.handle(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin" }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /auth/session", () => {
  test("ไม่มีคุกกี้ -> authenticated false", async () => {
    const { app } = await makeApp();
    const res = await app.handle(new Request("http://localhost/api/v1/auth/session"));
    expect(await json(res)).toEqual({ authenticated: false });
  });

  test("มี session cookie -> คืน username", async () => {
    const { app } = await makeApp();
    const { cookies } = await login(app);
    const res = await app.handle(
      new Request("http://localhost/api/v1/auth/session", {
        headers: { cookie: cookieHeader(cookies) },
      }),
    );
    expect(await json(res)).toMatchObject({ authenticated: true, username: "admin" });
  });

  test("session ที่ถูก revoke ใช้ไม่ได้", async () => {
    const { db, app } = await makeApp();
    const { cookies } = await login(app);
    db.query("UPDATE sessions SET revoked_at = ?").run(Date.now());

    const res = await app.handle(
      new Request("http://localhost/api/v1/auth/session", {
        headers: { cookie: cookieHeader(cookies) },
      }),
    );
    expect(await json(res)).toEqual({ authenticated: false });
  });

  test("token ปลอมใช้ไม่ได้", async () => {
    const { app } = await makeApp();
    const res = await app.handle(
      new Request("http://localhost/api/v1/auth/session", {
        headers: { cookie: "zx_session=forged-token-value" },
      }),
    );
    expect(await json(res)).toEqual({ authenticated: false });
  });
});

describe("POST /auth/logout", () => {
  test("logout พร้อม CSRF ที่ถูกต้อง -> session ใช้ต่อไม่ได้", async () => {
    const { app } = await makeApp();
    const { cookies } = await login(app);

    const res = await app.handle(
      new Request("http://localhost/api/v1/auth/logout", {
        method: "POST",
        headers: { cookie: cookieHeader(cookies), "x-csrf-token": cookies.zx_csrf ?? "" },
      }),
    );
    expect(res.status).toBe(200);

    const after = await app.handle(
      new Request("http://localhost/api/v1/auth/session", {
        headers: { cookie: cookieHeader(cookies) },
      }),
    );
    expect(await json(after)).toEqual({ authenticated: false });
  });

  test("logout ที่ไม่มี CSRF header ถูกปฏิเสธ", async () => {
    const { app } = await makeApp();
    const { cookies } = await login(app);

    const res = await app.handle(
      new Request("http://localhost/api/v1/auth/logout", {
        method: "POST",
        headers: { cookie: cookieHeader(cookies) },
      }),
    );
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("CSRF_REJECTED");
  });
});

describe("session rotation (Phase 8 M5)", () => {
  test("session เก่าเกิน rotation interval -> ได้ token ใหม่แบบโปร่งใส, token เก่าใช้ไม่ได้ต่อ", async () => {
    const { db, app } = await makeApp();
    const { cookies } = await login(app);

    // จำลอง session ที่สร้างมานานเกิน rotation interval (ปกติ createSession ใช้ Date.now())
    db.query("UPDATE sessions SET created_at = ?").run(Date.now() - 25 * 60 * 60 * 1000);

    const res = await app.handle(
      new Request("http://localhost/api/v1/auth/session", {
        headers: { cookie: cookieHeader(cookies) },
      }),
    );
    expect(await json(res)).toMatchObject({ authenticated: true, username: "admin" });

    const rotatedCookies = parseCookies(res);
    expect(rotatedCookies.zx_session).toBeDefined();
    expect(rotatedCookies.zx_session).not.toBe(cookies.zx_session);
    expect(rotatedCookies.zx_csrf).not.toBe(cookies.zx_csrf);

    // token เดิม (pre-rotation) ใช้ต่อไม่ได้อีกแล้ว — ถูก revoke ทันทีตอน rotate
    const oldTokenRes = await app.handle(
      new Request("http://localhost/api/v1/auth/session", {
        headers: { cookie: cookieHeader(cookies) },
      }),
    );
    expect(await json(oldTokenRes)).toEqual({ authenticated: false });

    // token ใหม่ใช้งานได้ปกติ
    const newTokenRes = await app.handle(
      new Request("http://localhost/api/v1/auth/session", {
        headers: { cookie: cookieHeader(rotatedCookies) },
      }),
    );
    expect(await json(newTokenRes)).toMatchObject({ authenticated: true, username: "admin" });
  });

  test("session ยังไม่ถึง rotation interval -> ไม่ set cookie ใหม่", async () => {
    const { app } = await makeApp();
    const { cookies } = await login(app);

    const res = await app.handle(
      new Request("http://localhost/api/v1/auth/session", {
        headers: { cookie: cookieHeader(cookies) },
      }),
    );
    expect(res.headers.getSetCookie().length).toBe(0);
  });

  test("rotation ระหว่าง mutating request ไม่ทำให้ CSRF check ของ request เดียวกันพัง", async () => {
    const { db, app } = await makeApp();
    const { cookies } = await login(app);
    db.query("UPDATE sessions SET created_at = ?").run(Date.now() - 25 * 60 * 60 * 1000);

    // logout เป็น mutating request ที่ผ่าน assertCsrf — ต้องผ่านแม้ session เพิ่งถูก rotate ระหว่าง request นี้
    const res = await app.handle(
      new Request("http://localhost/api/v1/auth/logout", {
        method: "POST",
        headers: { cookie: cookieHeader(cookies), "x-csrf-token": cookies.zx_csrf ?? "" },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("security headers", () => {
  test("ทุก response มี security headers", async () => {
    const { app } = await makeApp();
    const res = await app.handle(new Request("http://localhost/api/v1/auth/session"));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
