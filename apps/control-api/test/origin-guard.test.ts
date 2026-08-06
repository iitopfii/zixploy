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

describe("origin guard — Host header", () => {
  test("ไม่มี Host header เลย (เช่นเทสต์ที่สร้าง Request ตรง ๆ) -> ผ่าน", async () => {
    const app = makeApp("https://zixploy.example.com");
    const res = await app.handle(new Request("http://localhost/api/v1/system/health"));
    expect(res.status).not.toBe(400);
  });

  test("Host ตรงกับ ZIXPLOY_BASE_URL -> ผ่าน", async () => {
    const app = makeApp("https://zixploy.example.com");
    const res = await app.handle(
      new Request("http://localhost/api/v1/system/health", {
        headers: { host: "zixploy.example.com" },
      }),
    );
    expect(res.status).not.toBe(400);
  });

  test("Host ปลอม/ไม่ตรง -> 400 INVALID_HOST", async () => {
    const app = makeApp("https://zixploy.example.com");
    const res = await app.handle(
      new Request("http://localhost/api/v1/system/health", {
        headers: { host: "evil.example.com" },
      }),
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("INVALID_HOST");
  });

  test("localhost ยังผ่านได้เสมอใน dev/test แม้ตั้ง ZIXPLOY_BASE_URL เป็นโดเมนอื่น", async () => {
    const app = makeApp("https://zixploy.example.com");
    const res = await app.handle(
      new Request("http://localhost/api/v1/system/health", {
        headers: { host: "localhost" },
      }),
    );
    expect(res.status).not.toBe(400);
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
