import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { buildApp } from "../src/app";
import { json } from "./helpers";

/**
 * Origin/Host validation (Phase 8 M5) — apps/control-api/src/plugins/origin-guard.ts
 *
 * bun test สร้าง Request แบบในหน่วยความจำ (ไม่ผ่าน socket จริง) จึงไม่มี Host header ให้อัตโนมัติ
 * เหมือน HTTP/1.1 จริง — เทสต์พวกนี้ set header เองตรง ๆ เพื่อจำลอง attacker ที่ปลอม header ได้
 */

function makeApp(baseUrl?: string) {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return buildApp(db, baseUrl ? { baseUrl } : {});
}

/**
 * path สำหรับทดสอบการตรวจ Host — ต้อง **ไม่ใช่** /system/health ซึ่งได้รับยกเว้นโดยตั้งใจ
 * (ดู HEALTH_PATH ใน origin-guard.ts) ใช้ /auth/session เพราะตอบได้โดยไม่ต้อง login
 */
const GUARDED_PATH = "http://localhost/api/v1/auth/session";

describe("origin guard — Host header", () => {
  test("ไม่มี Host header เลย (เช่นเทสต์ที่สร้าง Request ตรง ๆ) -> ผ่าน", async () => {
    const app = makeApp("https://zixploy.example.com");
    const res = await app.handle(new Request(GUARDED_PATH));
    expect(res.status).not.toBe(400);
  });

  test("Host ตรงกับ ZIXPLOY_BASE_URL -> ผ่าน", async () => {
    const app = makeApp("https://zixploy.example.com");
    const res = await app.handle(
      new Request(GUARDED_PATH, { headers: { host: "zixploy.example.com" } }),
    );
    expect(res.status).not.toBe(400);
  });

  test("Host ปลอม/ไม่ตรง -> 400 INVALID_HOST", async () => {
    const app = makeApp("https://zixploy.example.com");
    const res = await app.handle(
      new Request(GUARDED_PATH, { headers: { host: "evil.example.com" } }),
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("INVALID_HOST");
  });

  test("localhost ยังผ่านได้เสมอใน dev/test แม้ตั้ง ZIXPLOY_BASE_URL เป็นโดเมนอื่น", async () => {
    const app = makeApp("https://zixploy.example.com");
    const res = await app.handle(new Request(GUARDED_PATH, { headers: { host: "localhost" } }));
    expect(res.status).not.toBe(400);
  });
});

/**
 * ยกเว้น health endpoint — เคยทำ production ล่มมาแล้ว:
 * NODE_ENV=production ตัด 127.0.0.1 ออกจาก allowlist → Docker healthcheck (`Host: 127.0.0.1:3001`)
 * ได้ 400 → container unhealthy → Traefik ข้าม container → API ตายทั้งระบบ
 */
describe("origin guard — health endpoint ต้องเข้าถึงได้เสมอ", () => {
  const HEALTH = "http://localhost/api/v1/system/health";

  test("Host: 127.0.0.1:3001 (Docker healthcheck) -> ผ่าน แม้ไม่อยู่ใน allowlist", async () => {
    const app = makeApp("https://zixploy.example.com");
    const res = await app.handle(new Request(HEALTH, { headers: { host: "127.0.0.1:3001" } }));
    expect(res.status).toBe(200);
    expect((await json(res)).status).toBeDefined();
  });

  test("Host แปลกปลอมสิ้นดี -> ยังผ่าน (endpoint ไม่สะท้อน Host กลับไป จึงไม่มีช่องโจมตี)", async () => {
    const app = makeApp("https://zixploy.example.com");
    const res = await app.handle(new Request(HEALTH, { headers: { host: "evil.example.com" } }));
    expect(res.status).toBe(200);
  });

  test("การยกเว้นดูที่ pathname เท่านั้น — ปลอม query string ไม่ช่วยให้ path อื่นหลุด", async () => {
    const app = makeApp("https://zixploy.example.com");
    const res = await app.handle(
      new Request(`${GUARDED_PATH}?next=/api/v1/system/health`, {
        headers: { host: "evil.example.com" },
      }),
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("INVALID_HOST");
  });
});

describe("origin guard — Origin header (mutating requests)", () => {
  test("GET ไม่เช็ค Origin แม้ Host ตรง", async () => {
    const app = makeApp("https://zixploy.example.com");
    const res = await app.handle(
      new Request("http://localhost/api/v1/system/health", {
        headers: { host: "zixploy.example.com", origin: "https://evil.example.com" },
      }),
    );
    expect(res.status).not.toBe(403);
  });

  test("POST ไม่มี Origin header -> ไม่ถูกบล็อกโดย origin guard (CSRF/auth layer จัดการต่อ)", async () => {
    const app = makeApp("https://zixploy.example.com");
    const res = await app.handle(
      new Request("http://localhost/api/v1/auth/logout", {
        method: "POST",
        headers: { host: "zixploy.example.com" },
      }),
    );
    // ไม่ใช่ INVALID_ORIGIN — 401 เพราะไม่ได้ login ต่างหาก
    expect((await json(res)).error?.code).not.toBe("INVALID_ORIGIN");
  });

  test("POST พร้อม Origin ปลอม -> 403 INVALID_ORIGIN", async () => {
    const app = makeApp("https://zixploy.example.com");
    const res = await app.handle(
      new Request("http://localhost/api/v1/auth/logout", {
        method: "POST",
        headers: { host: "zixploy.example.com", origin: "https://evil.example.com" },
      }),
    );
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("INVALID_ORIGIN");
  });

  test("POST พร้อม Origin ตรงกับ base url -> ผ่าน origin guard", async () => {
    const app = makeApp("https://zixploy.example.com");
    const res = await app.handle(
      new Request("http://localhost/api/v1/auth/logout", {
        method: "POST",
        headers: { host: "zixploy.example.com", origin: "https://zixploy.example.com" },
      }),
    );
    expect((await json(res)).error?.code).not.toBe("INVALID_ORIGIN");
  });
});
