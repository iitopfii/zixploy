import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import {
  AppError,
  errorText,
  LocalizedError,
  localeFromHeaders,
  localize,
  toErrorEnvelope,
  ulid,
} from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { json } from "./helpers";

const PASSWORD = "correct horse battery staple";

function makeApp() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return { db, app: buildApp(db) };
}

const get = (
  app: ReturnType<typeof buildApp>,
  path: string,
  headers: Record<string, string> = {},
) => app.handle(new Request(`http://localhost/api/v1${path}`, { headers }));

describe("localeFromHeaders", () => {
  const headers = (init: Record<string, string>) => new Headers(init);

  test("ไม่ระบุ = ไทย (client เดิมได้ข้อความเหมือนก่อน)", () => {
    expect(localeFromHeaders(headers({}))).toBe("th");
    // ไม่อ่าน Accept-Language โดยตั้งใจ
    expect(localeFromHeaders(headers({ "accept-language": "en-US,en;q=0.9" }))).toBe("th");
  });

  test("header มาก่อนคุกกี้", () => {
    expect(localeFromHeaders(headers({ "x-zixploy-locale": "en" }))).toBe("en");
    expect(localeFromHeaders(headers({ cookie: "a=1; zx_locale=en; b=2" }))).toBe("en");
    expect(localeFromHeaders(headers({ "x-zixploy-locale": "th", cookie: "zx_locale=en" }))).toBe(
      "th",
    );
  });

  test("ค่าที่ไม่รู้จักถูกข้าม", () => {
    expect(localeFromHeaders(headers({ "x-zixploy-locale": "fr" }))).toBe("th");
    expect(localeFromHeaders(headers({ "x-zixploy-locale": "fr", cookie: "zx_locale=en" }))).toBe(
      "en",
    );
    expect(localeFromHeaders(headers({ cookie: "zx_locale=__proto__" }))).toBe("th");
  });
});

describe("AppError สองภาษา", () => {
  test("message เป็นไทยเสมอ · envelope เลือกตามภาษา", () => {
    const error = new AppError("NOT_FOUND", { th: "ไม่พบ", en: "Not found" });
    expect(error.message).toBe("ไม่พบ");
    expect(toErrorEnvelope(error, "r1").error.message).toBe("ไม่พบ");
    expect(toErrorEnvelope(error, "r1", "en").error.message).toBe("Not found");
  });

  test("string เดียว = ใช้ค่าเดิมทุกภาษา", () => {
    const error = new AppError("NOT_FOUND", "ยังไม่ได้แปล");
    expect(toErrorEnvelope(error, "r1", "en").error.message).toBe("ยังไม่ได้แปล");
    expect(localize("x", "en")).toBe("x");
  });

  test("errorText ส่งต่อข้อความสองภาษาจาก error ชั้นใน", () => {
    const fallback = { th: "สำรอง", en: "fallback" };
    expect(errorText(new LocalizedError({ th: "ก", en: "a" }), fallback)).toEqual({
      th: "ก",
      en: "a",
    });
    expect(errorText(new AppError("NOT_FOUND", { th: "ข", en: "b" }), fallback)).toEqual({
      th: "ข",
      en: "b",
    });
    expect(errorText(new Error("plain"), fallback)).toBe("plain");
    expect(errorText("not an error", fallback)).toEqual(fallback);
  });
});

describe("API ตอบ error ตามภาษาที่เลือก", () => {
  test("401 — ไทยเป็นค่าเริ่มต้น, อังกฤษผ่าน header หรือคุกกี้", async () => {
    const { app } = makeApp();
    const th = await json(await get(app, "/projects"));
    expect(th.error.code).toBe("UNAUTHENTICATED");
    expect(th.error.message).toBe("ต้อง login ก่อนใช้งาน endpoint นี้");

    const byHeader = await json(await get(app, "/projects", { "x-zixploy-locale": "en" }));
    expect(byHeader.error.code).toBe("UNAUTHENTICATED");
    expect(byHeader.error.message).toBe("Sign in to use this endpoint");

    const byCookie = await json(await get(app, "/projects", { cookie: "zx_locale=en" }));
    expect(byCookie.error.message).toBe("Sign in to use this endpoint");
  });

  test("login ผิด และ endpoint ที่ไม่มี — ข้อความอังกฤษไม่มีอักษรไทย", async () => {
    const { db, app } = makeApp();
    const now = Date.now();
    db.query(
      "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(ulid(), "admin", await hashPassword(PASSWORD), now, now);

    const login = await app.handle(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-zixploy-locale": "en" },
        body: JSON.stringify({ username: "admin", password: "wrong password here" }),
      }),
    );
    expect(login.status).toBe(401);
    const loginBody = await json(login);
    expect(loginBody.error.message).toBe("Incorrect username or password");

    const missing = await json(await get(app, "/nope", { "x-zixploy-locale": "en" }));
    expect(missing.error.code).toBe("NOT_FOUND");
    expect(missing.error.message).not.toMatch(/[฀-๿]/);
  });
});
