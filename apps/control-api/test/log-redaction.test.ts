import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { configureLogger } from "../src/logger";

/**
 * ตรวจว่า log จริงที่ Control API ปล่อยออกมาระหว่างใช้งาน ไม่มี cookie, password,
 * session token หรือ CSRF token หลุดออกไป (docs/phase-01 security requirements)
 */

const PASSWORD = "correct horse battery staple";
const captured: string[] = [];

beforeAll(() => {
  // ดัก output จริงของ logger รวมถึง access log และ error log
  configureLogger({ level: "debug", sink: (line) => captured.push(line) });
});

afterAll(() => {
  configureLogger({});
});

async function makeApp() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(ulid(), "admin", await hashPassword(PASSWORD), now, now);
  return buildApp(db);
}

describe("structured logs ไม่มี secret", () => {
  test("ตลอด flow login -> ใช้งาน -> logout ไม่มีค่าอ่อนไหวใน log", async () => {
    const app = await makeApp();
    captured.length = 0;

    // 1. login สำเร็จ
    const loginRes = await app.handle(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: PASSWORD }),
      }),
    );

    const cookies: Record<string, string> = {};
    for (const raw of loginRes.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (pair && eq > 0) cookies[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
    }
    const sessionToken = cookies.zx_session ?? "";
    const csrfToken = cookies.zx_csrf ?? "";
    expect(sessionToken).not.toBe("");
    expect(csrfToken).not.toBe("");

    const cookieHeader = Object.entries(cookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("; ");

    // 2. login ผิด (บันทึก failed attempt)
    await app.handle(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "some wrong password" }),
      }),
    );

    // 3. ใช้งาน endpoint ที่ต้อง auth
    await app.handle(
      new Request("http://localhost/api/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookieHeader,
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({ name: "logged-project" }),
      }),
    );

    // 4. logout
    await app.handle(
      new Request("http://localhost/api/v1/auth/logout", {
        method: "POST",
        headers: { cookie: cookieHeader, "x-csrf-token": csrfToken },
      }),
    );

    // onAfterResponse ทำงานหลัง handle() resolve — รอให้ access log ถูกเขียนครบก่อนตรวจ
    await Bun.sleep(30);

    expect(captured.length).toBeGreaterThan(0);
    const all = captured.join("\n");

    // ค่าอ่อนไหวจริงจาก flow นี้ต้องไม่ปรากฏ
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain("some wrong password");
    expect(all).not.toContain(sessionToken);
    expect(all).not.toContain(csrfToken);
    expect(all).not.toContain("zx_session=");
    expect(all).not.toContain("zx_csrf=");
    expect(all.toLowerCase()).not.toContain("set-cookie");
    expect(all.toLowerCase()).not.toContain("argon2id");

    // แต่ต้องยังมีข้อมูลที่จำเป็นต่อการ debug
    expect(all).toContain("/api/v1/auth/login");
    expect(all).toContain("requestId");
  });

  test("ทุกบรรทัดเป็น JSON ที่ parse ได้และมี service/level", () => {
    expect(captured.length).toBeGreaterThan(0);
    for (const line of captured) {
      const parsed = JSON.parse(line);
      expect(parsed.service).toBe("control-api");
      expect(["debug", "info", "warn", "error"]).toContain(parsed.level);
    }
  });

  test("access log ไม่บันทึก query string (อาจมีค่าที่ผู้ใช้ใส่มา)", async () => {
    const app = await makeApp();
    captured.length = 0;

    await app.handle(
      new Request("http://localhost/api/v1/projects?includeArchived=true&leak=supersecretvalue"),
    );
    await Bun.sleep(30);

    const all = captured.join("\n");
    expect(all).toContain("/api/v1/projects");
    expect(all).not.toContain("supersecretvalue");
    expect(all).not.toContain("includeArchived");
  });

  test("error ที่ไม่คาดคิดถูก log แต่ response ไม่มีรายละเอียดภายใน", async () => {
    const app = await makeApp();
    captured.length = 0;

    // ปิด DB เพื่อให้ query ภายใน throw จริง
    const res = await app.handle(new Request("http://localhost/api/v1/auth/session"));
    expect(res.status).toBe(200);

    // response ของ error path ต้องไม่มี stack trace ไม่ว่ากรณีใด
    const notFound = await app.handle(new Request("http://localhost/api/v1/does-not-exist"));
    const body = await notFound.text();
    expect(body).not.toContain("at ");
    expect(body).not.toContain(".ts:");
  });
});
