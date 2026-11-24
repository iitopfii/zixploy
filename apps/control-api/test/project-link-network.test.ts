/**
 * link network ต่อ project (0.1.26) — PATCH /projects/:id { linkNetwork }
 *
 * ครอบ: ตั้ง/ล้าง, รูปแบบผิด, ใช้ได้เฉพาะ compose, ชื่อ component ชนกับ project อื่นใน link เดียวกัน
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { json } from "./helpers";

type Db = ReturnType<typeof openDatabase>;

function insertProject(db: Db, name: string, mode: "single" | "compose"): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO projects (id, name, status, mode, dockerfile_path, build_context, restart_policy,
       deploy_timeout_sec, created_at, updated_at)
     VALUES (?, ?, 'new', ?, 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(id, name, mode, now, now);
  return id;
}

function insertComponent(db: Db, projectId: string, name: string) {
  const now = Date.now();
  db.query(
    `INSERT INTO project_components (id, project_id, name, role, source_kind, image_ref, position,
       enabled, created_at, updated_at)
     VALUES (?, ?, ?, 'app', 'image', 'nginx:1', 0, 1, ?, ?)`,
  ).run(ulid(), projectId, name, now, now);
}

async function setup() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)",
  ).run(ulid(), await hashPassword("adminpass123"), now, now);
  const app = buildApp(db);
  const res = await app.handle(
    new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "adminpass123" }),
    }),
  );
  const cookies: Record<string, string> = {};
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (pair && eq > 0) cookies[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
  const csrf = cookies.zx_csrf ?? "";
  const patch = (projectId: string, body: unknown) =>
    app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify(body),
      }),
    );
  return { db, patch };
}

describe("project linkNetwork", () => {
  test("ตั้งแล้วล้างกลับเป็น null ได้ · PATCH field อื่นไม่แตะ", async () => {
    const { db, patch } = await setup();
    const id = insertProject(db, "app", "compose");
    const set = await patch(id, { linkNetwork: "sealand" });
    expect(set.status).toBe(200);
    expect((await json(set)).linkNetwork).toBe("sealand");
    const other = await json(await patch(id, { name: "app2" }));
    expect(other.linkNetwork).toBe("sealand");
    const cleared = await json(await patch(id, { linkNetwork: null }));
    expect(cleared.linkNetwork).toBeNull();
  });

  test("รูปแบบผิด → 400 ไม่บันทึก", async () => {
    const { db, patch } = await setup();
    const id = insertProject(db, "app", "compose");
    for (const linkNetwork of ["Sealand", "-x", "a_b", "a b", ""]) {
      const res = await patch(id, { linkNetwork });
      expect(res.status).toBe(400);
    }
    const row = db
      .query<{ link_network: string | null }, [string]>(
        "SELECT link_network FROM projects WHERE id = ?",
      )
      .get(id);
    expect(row?.link_network).toBeNull();
  });

  test("project แบบ single ตั้งไม่ได้", async () => {
    const { db, patch } = await setup();
    const id = insertProject(db, "single", "single");
    expect((await patch(id, { linkNetwork: "sealand" })).status).toBe(400);
  });

  test("ชื่อ component ชนกับ project อื่นใน link เดียวกัน → 400 บอกชื่อที่ชน", async () => {
    const { db, patch } = await setup();
    const ml = insertProject(db, "ml", "compose");
    insertComponent(db, ml, "tei");
    expect((await patch(ml, { linkNetwork: "sealand" })).status).toBe(200);

    const app = insertProject(db, "app", "compose");
    insertComponent(db, app, "tei");
    insertComponent(db, app, "api");
    const res = await patch(app, { linkNetwork: "sealand" });
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toContain('"tei" (ml)');

    // link อื่นไม่ชน
    expect((await patch(app, { linkNetwork: "other" })).status).toBe(200);
  });
});
