/**
 * Project exposed port (Phase 14) — PATCH /api/v1/projects/:id { exposedPort }
 * เน้น conflict detection: ชน project อื่น / managed service / port ของระบบเอง
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { createMockRegistry } from "./github-mock";
import { json } from "./helpers";

async function setup() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));

  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)",
  ).run(ulid(), await hashPassword("correct horse battery staple"), now, now);

  const app = buildApp(db, { registry: createMockRegistry({}) });

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

function insertProject(ctx: Ctx, name = "p1", exposedPort: number | null = null) {
  const id = ulid();
  const now = Date.now();
  ctx.db
    .query(
      `INSERT INTO projects (id, name, status, dockerfile_path, build_context, exposed_port, restart_policy, deploy_timeout_sec, created_at, updated_at)
       VALUES (?, ?, 'new', 'Dockerfile', '.', ?, 'unless-stopped', 900, ?, ?)`,
    )
    .run(id, name, exposedPort, now, now);
  return id;
}

function patchProject(ctx: Ctx, id: string, body: Record<string, unknown>) {
  return ctx.app.handle(
    new Request(`http://localhost/api/v1/projects/${id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: ctx.cookie,
        "x-csrf-token": ctx.csrf,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("PATCH /projects/:id exposedPort", () => {
  test("ตั้งค่าได้และคืนกลับใน response + อยู่ใน DB", async () => {
    const ctx = await setup();
    const id = insertProject(ctx);

    const res = await patchProject(ctx, id, { exposedPort: 3100 });
    expect(res.status).toBe(200);
    expect((await json(res)).exposedPort).toBe(3100);

    const row = ctx.db
      .query<{ exposed_port: number | null }, [string]>(
        "SELECT exposed_port FROM projects WHERE id = ?",
      )
      .get(id);
    expect(row?.exposed_port).toBe(3100);
  });

  test("ล้างค่าด้วย null", async () => {
    const ctx = await setup();
    const id = insertProject(ctx, "p1", 3100);
    const res = await patchProject(ctx, id, { exposedPort: null });
    expect((await json(res)).exposedPort).toBeNull();
  });

  test("ชน port ของ project อื่น → 400 พร้อมชื่อ project", async () => {
    const ctx = await setup();
    insertProject(ctx, "taken-by-me", 3100);
    const id = insertProject(ctx, "p2");

    const res = await patchProject(ctx, id, { exposedPort: 3100 });
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toContain("taken-by-me");
  });

  test("ตั้ง port เดิมของตัวเองซ้ำ → ผ่าน (ไม่นับว่าชนตัวเอง)", async () => {
    const ctx = await setup();
    const id = insertProject(ctx, "p1", 3100);
    const res = await patchProject(ctx, id, { exposedPort: 3100 });
    expect(res.status).toBe(200);
  });

  test("ชน port ของ managed service → 400 พร้อมชื่อ database", async () => {
    const ctx = await setup();
    const now = Date.now();
    ctx.db
      .query(
        `INSERT INTO services (id, name, type, version, image, status, volume_name, username, database_name, internal_port, exposed_port, created_at, updated_at)
         VALUES (?, 'my-postgres', 'postgres', '16', 'postgres:16', 'running', 'v1', 'u', 'db', 5432, 3100, ?, ?)`,
      )
      .run(ulid(), now, now);
    const id = insertProject(ctx, "p1");

    const res = await patchProject(ctx, id, { exposedPort: 3100 });
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toContain("my-postgres");
  });

  test("port ที่ระบบใช้เอง (80/443/3000/3001) → 400", async () => {
    const ctx = await setup();
    const id = insertProject(ctx);
    for (const port of [80, 443, 3000, 3001]) {
      const res = await patchProject(ctx, id, { exposedPort: port });
      expect(res.status).toBe(400);
    }
  });

  test("นอกช่วง 1-65535 → 400 (schema validation)", async () => {
    const ctx = await setup();
    const id = insertProject(ctx);
    for (const port of [0, 65536, -1]) {
      const res = await patchProject(ctx, id, { exposedPort: port });
      expect(res.status).toBe(400);
    }
  });
});
