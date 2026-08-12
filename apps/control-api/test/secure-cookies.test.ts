/**
 * Secure flag ของ session/CSRF cookie — ตัดสินจาก scheme ของ ZIXPLOY_BASE_URL
 *
 * เหตุผลที่ต้องมีเทสต์ชุดนี้: เกณฑ์เดิมคือ `NODE_ENV === "production"` ซึ่งพังกับการติดตั้งที่เข้า
 * ผ่าน IP ตรง ๆ (http://<ip>) — ตั้ง Secure บน HTTP เมื่อไหร่ browser ทิ้ง cookie ทันที ผู้ใช้
 * login ไม่ได้ทั้งระบบและล็อกตัวเองออก แก้ยากเพราะ "ตั้งค่าถูกตามคู่มือ" แต่ใช้งานไม่ได้
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { isSecureBaseUrl } from "../src/auth/session";

const PASSWORD = "correct horse battery staple";

describe("isSecureBaseUrl", () => {
  test("https → true", () => {
    expect(isSecureBaseUrl("https://zixploy.example.com")).toBe(true);
    expect(isSecureBaseUrl("https://zixploy.example.com:8443")).toBe(true);
    // scheme เป็น case-insensitive ตาม RFC 3986
    expect(isSecureBaseUrl("HTTPS://zixploy.example.com")).toBe(true);
    expect(isSecureBaseUrl("  https://zixploy.example.com  ")).toBe(true);
  });

  test("http → false (เคสที่เคยทำให้ล็อกตัวเองออกจากระบบ)", () => {
    expect(isSecureBaseUrl("http://103.114.203.205")).toBe(false);
    expect(isSecureBaseUrl("http://103.114.203.205:8080")).toBe(false);
    expect(isSecureBaseUrl("http://localhost:3001")).toBe(false);
  });

  test("ไม่ตั้งค่า/ค่าพัง → false (fail safe: ยอมไม่มี Secure ดีกว่า login ไม่ได้)", () => {
    expect(isSecureBaseUrl(undefined)).toBe(false);
    expect(isSecureBaseUrl("")).toBe(false);
    expect(isSecureBaseUrl("103.114.203.205")).toBe(false);
    // ห้าม match แบบหลวม ๆ ด้วย substring — ต้องเป็น scheme ขึ้นต้นจริงเท่านั้น
    expect(isSecureBaseUrl("http://evil.test/?x=https://")).toBe(false);
  });
});

describe("Set-Cookie จริงตอน login", () => {
  test("base URL เป็น http (ค่าใน test env) → cookie ไม่มี Secure flag", async () => {
    const db = openDatabase({ path: ":memory:" });
    migrateUp(db, loadMigrations(migrationsDir()));
    const now = Date.now();
    db.query(
      "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)",
    ).run(ulid(), await hashPassword(PASSWORD), now, now);

    const app = buildApp(db);
    const res = await app.handle(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: PASSWORD }),
      }),
    );
    expect(res.status).toBe(200);

    const cookies = res.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(cookie.toLowerCase()).not.toContain("secure");
    }
    // HttpOnly/SameSite ยังต้องอยู่ครบเหมือนเดิม — Secure ที่หายไปต้องไม่ลากอย่างอื่นหายตาม
    const session = cookies.find((c) => c.startsWith("zx_session="));
    expect(session?.toLowerCase()).toContain("httponly");
    expect(session?.toLowerCase()).toContain("samesite");
  });
});
