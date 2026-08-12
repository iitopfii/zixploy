/**
 * System settings (Phase 14) — GET/PUT /api/v1/system/settings + origin-guard dynamic host
 *
 * จุดสำคัญที่สุด: dashboard domain ที่ตั้งใหม่ต้องมีผล "ทันที" กับ origin-guard โดยไม่ restart —
 * นี่คือเหตุผลทั้งหมดของฟีเจอร์ (แก้ INVALID_HOST จาก UI แทน SSH ไปแก้ .env)
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { createMockRegistry } from "./github-mock";
import { json } from "./helpers";

async function setup(baseUrl?: string) {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));

  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)",
  ).run(ulid(), await hashPassword("correct horse battery staple"), now, now);

  const app = buildApp(db, {
    registry: createMockRegistry({}),
    ...(baseUrl ? { baseUrl } : {}),
  });

  const loginRes = await app.handle(
    new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct horse battery staple" }),
    }),
  );
  const cookies: Record<string, string> = {};
  for (const raw of loginRes.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (pair && eq > 0) cookies[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
  return { db, app, cookie, csrf: cookies.zx_csrf ?? "" };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

function putSettings(ctx: Ctx, dashboardDomain: string | null) {
  return ctx.app.handle(
    new Request("http://localhost/api/v1/system/settings", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie: ctx.cookie,
        "x-csrf-token": ctx.csrf,
      },
      body: JSON.stringify({ dashboardDomain }),
    }),
  );
}

describe("GET/PUT /system/settings", () => {
  test("ค่าเริ่มต้น: dashboardDomain เป็น null", async () => {
    const ctx = await setup();
    const res = await ctx.app.handle(
      new Request("http://localhost/api/v1/system/settings", { headers: { cookie: ctx.cookie } }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.dashboardDomain).toBeNull();
    expect(Array.isArray(body.serverIps)).toBe(true);
  });

  test("PUT ตั้ง domain → GET เห็นค่าที่ตั้ง และค่าอยู่ใน DB จริง (รอด restart)", async () => {
    const ctx = await setup();
    const res = await putSettings(ctx, "dash.example.com");
    expect(res.status).toBe(200);
    expect((await json(res)).dashboardDomain).toBe("dash.example.com");

    const row = ctx.db
      .query<{ value: string }, [string]>("SELECT value FROM system_settings WHERE key = ?")
      .get("dashboard_domain");
    expect(row?.value).toBe("dash.example.com");
  });

  test("PUT null → ล้างค่า", async () => {
    const ctx = await setup();
    await putSettings(ctx, "dash.example.com");
    const res = await putSettings(ctx, null);
    expect((await json(res)).dashboardDomain).toBeNull();
    const row = ctx.db
      .query<{ value: string }, [string]>("SELECT value FROM system_settings WHERE key = ?")
      .get("dashboard_domain");
    expect(row).toBeNull();
  });

  test("domain รูปแบบผิด (มี scheme/path/wildcard) → 400", async () => {
    const ctx = await setup();
    for (const bad of ["https://x.com", "x.com/path", "*.example.com", "not a domain"]) {
      const res = await putSettings(ctx, bad);
      expect(res.status).toBe(400);
    }
  });

  test("ไม่ login → 401", async () => {
    const ctx = await setup();
    const res = await ctx.app.handle(
      new Request("http://localhost/api/v1/system/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dashboardDomain: "x.example.com" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("บันทึก audit event", async () => {
    const ctx = await setup();
    await putSettings(ctx, "dash.example.com");
    const actions = ctx.db
      .query<{ action: string }, []>("SELECT action FROM audit_events")
      .all()
      .map((r) => r.action);
    expect(actions).toContain("system_settings_updated");
  });
});

describe("origin-guard + dashboard domain (หัวใจของฟีเจอร์)", () => {
  test("Host ที่ไม่รู้จัก → INVALID_HOST, หลังตั้ง dashboard domain → ผ่านทันทีไม่ต้อง restart", async () => {
    // ตั้ง baseUrl เพื่อเปิด origin guard (allowlist ไม่ว่าง) — non-production ยังอนุโลม localhost
    // ให้ login/PUT ผ่านได้ตามปกติ
    const ctx = await setup("http://10.0.0.1");

    const attempt = () =>
      ctx.app.handle(
        new Request("http://dash.example.com/api/v1/system/health", {
          headers: { host: "dash.example.com" },
        }),
      );

    // ก่อนตั้ง — โดนปฏิเสธ
    const before = await attempt();
    expect(before.status).toBe(400);
    expect((await json(before)).error.code).toBe("INVALID_HOST");

    // ตั้ง domain ผ่าน API (ผ่าน host localhost ที่ dev อนุโลม)
    const put = await putSettings(ctx, "dash.example.com");
    expect(put.status).toBe(200);

    // หลังตั้ง — app instance เดิม ไม่ restart — ต้องผ่านทันที
    const after = await attempt();
    expect(after.status).toBe(200);
  });

  test("ล้าง domain แล้ว host นั้นถูกปฏิเสธอีกครั้ง", async () => {
    const ctx = await setup("http://10.0.0.1");
    await putSettings(ctx, "dash.example.com");
    await putSettings(ctx, null);

    const res = await ctx.app.handle(
      new Request("http://dash.example.com/api/v1/system/health", {
        headers: { host: "dash.example.com" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("domain ที่ตั้งไว้ก่อน restart ถูกโหลดกลับตอนสร้าง app ใหม่ (อ่านจาก DB)", async () => {
    const ctx = await setup("http://10.0.0.1");
    await putSettings(ctx, "dash.example.com");

    // จำลอง restart: สร้าง app ใหม่จาก DB เดิม
    const app2 = buildApp(ctx.db, {
      registry: createMockRegistry({}),
      baseUrl: "http://10.0.0.1",
    });
    const res = await app2.handle(
      new Request("http://dash.example.com/api/v1/system/health", {
        headers: { host: "dash.example.com" },
      }),
    );
    expect(res.status).toBe(200);
  });
});
