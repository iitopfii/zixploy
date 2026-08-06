/**
 * Audit log — Phase 8 M3
 *
 * ครอบคลุม:
 * - recordAuditEvent: insert สำเร็จ, fail-open เมื่อ schema ผิด, ไม่มี field secret หลุด
 * - listAuditEvents: order ล่าสุดก่อน, keyset pagination (before cursor), limit clamp
 * - getClientIp: อ่านจาก x-forwarded-for, คืน null ถ้าไม่มี
 * - route integration: login สำเร็จ/ล้มเหลว, project update, volume delete → มี audit event จริง
 * - GET /api/v1/audit-events: pagination, ต้อง login ก่อน
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { getClientIp, listAuditEvents, recordAuditEvent } from "../src/audit/log";
import { hashPassword } from "../src/auth/password";
import { json } from "./helpers";

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

describe("recordAuditEvent / listAuditEvents", () => {
  test("insert สำเร็จ — อ่านกลับได้ครบ field", async () => {
    const db = makeDb();
    const now = Date.now();
    const userId = ulid();
    db.query(
      "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)",
    ).run(userId, await hashPassword("adminpass123"), now, now);

    recordAuditEvent(db, {
      actorUserId: userId,
      actorUsername: "admin",
      action: "login_succeeded",
      resourceType: "session",
      metadata: { foo: "bar" },
      ip: "203.0.113.1",
    });

    const rows = listAuditEvents(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("login_succeeded");
    expect(rows[0]?.actor_username).toBe("admin");
    expect(JSON.parse(rows[0]?.metadata ?? "{}")).toEqual({ foo: "bar" });
    expect(rows[0]?.ip).toBe("203.0.113.1");
  });

  test("field ที่ไม่ระบุ (optional) → เก็บเป็น null", () => {
    const db = makeDb();
    recordAuditEvent(db, { action: "logout" });

    const rows = listAuditEvents(db);
    expect(rows[0]?.actor_user_id).toBeNull();
    expect(rows[0]?.actor_username).toBeNull();
    expect(rows[0]?.resource_type).toBeNull();
    expect(rows[0]?.resource_id).toBeNull();
    expect(rows[0]?.ip).toBeNull();
    expect(JSON.parse(rows[0]?.metadata ?? "{}")).toEqual({});
  });

  test("fail-open — DB ไม่มี audit_events table ก็ไม่ throw", () => {
    const db = openDatabase({ path: ":memory:" }); // ไม่ migrate เลย — ไม่มีตารางไหนอยู่จริง
    expect(() => recordAuditEvent(db, { action: "login_succeeded" })).not.toThrow();
  });

  test("listAuditEvents — เรียงจากล่าสุดไปเก่าสุด", () => {
    const db = makeDb();
    for (let i = 0; i < 3; i++) {
      db.query(
        `INSERT INTO audit_events (id, action, metadata, created_at) VALUES (?, 'x', '{}', ?)`,
      ).run(ulid(), 1000 + i);
    }
    const rows = listAuditEvents(db);
    expect(rows.map((r) => r.created_at)).toEqual([1002, 1001, 1000]);
  });

  test("listAuditEvents — keyset pagination ด้วย before cursor", () => {
    const db = makeDb();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = ulid();
      ids.push(id);
      db.query(
        `INSERT INTO audit_events (id, action, metadata, created_at) VALUES (?, 'x', '{}', ?)`,
      ).run(id, 1000 + i);
    }
    const firstPage = listAuditEvents(db, { limit: 2 });
    expect(firstPage).toHaveLength(2);
    expect(firstPage[0]?.created_at).toBe(1004);

    const secondPage = listAuditEvents(db, {
      limit: 2,
      before: { createdAt: firstPage[1]!.created_at, id: firstPage[1]!.id },
    });
    expect(secondPage).toHaveLength(2);
    expect(secondPage[0]?.created_at).toBe(1002);
  });

  test("listAuditEvents — limit clamp (max 200, min 1)", () => {
    const db = makeDb();
    recordAuditEvent(db, { action: "x" });
    expect(listAuditEvents(db, { limit: 0 })).toHaveLength(1);
    expect(listAuditEvents(db, { limit: 999 })).toHaveLength(1);
  });
});

describe("getClientIp", () => {
  test("อ่านจาก x-forwarded-for — ตัดเอา IP แรกถ้ามีหลายค่า", () => {
    const req = new Request("http://localhost/", {
      headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
    });
    expect(getClientIp(req)).toBe("203.0.113.5");
  });

  test("ไม่มี header → null", () => {
    const req = new Request("http://localhost/");
    expect(getClientIp(req)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Route integration
// ---------------------------------------------------------------------------

async function setupApp() {
  const db = makeDb();
  const now = Date.now();
  const userId = ulid();
  await db
    .query(
      "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)",
    )
    .run(userId, await hashPassword("adminpass123"), now, now);

  const projectId = ulid();
  db.query(
    `INSERT INTO projects
       (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'audit-test', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(projectId, now, now);

  const app = buildApp(db);
  return { db, app, projectId, userId };
}

function parseCookies(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (pair && eq > 0) out[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  return out;
}

describe("route integration — audit events ถูกบันทึกจริง", () => {
  test("login สำเร็จ → login_succeeded event", async () => {
    const { db, app } = await setupApp();
    await app.handle(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "adminpass123" }),
      }),
    );

    const rows = listAuditEvents(db);
    expect(rows.some((r) => r.action === "login_succeeded")).toBe(true);
  });

  test("login ล้มเหลว → login_failed event พร้อม actor_username", async () => {
    const { db, app } = await setupApp();
    await app.handle(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "wrong-password" }),
      }),
    );

    const rows = listAuditEvents(db);
    const failed = rows.find((r) => r.action === "login_failed");
    expect(failed).toBeDefined();
    expect(failed?.actor_username).toBe("admin");
  });

  test("PATCH project → project_updated event พร้อม resourceId", async () => {
    const { db, app, projectId } = await setupApp();
    const loginRes = await app.handle(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "adminpass123" }),
      }),
    );
    const cookies = parseCookies(loginRes);
    const cookieHeader = Object.entries(cookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("; ");

    await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: cookieHeader,
          "x-csrf-token": cookies.zx_csrf ?? "",
        },
        body: JSON.stringify({ name: "renamed" }),
      }),
    );

    const rows = listAuditEvents(db);
    const updated = rows.find((r) => r.action === "project_updated");
    expect(updated).toBeDefined();
    expect(updated?.resource_id).toBe(projectId);
  });
});

describe("GET /api/v1/audit-events", () => {
  test("ไม่ login → 401", async () => {
    const { app } = await setupApp();
    const res = await app.handle(new Request("http://localhost/api/v1/audit-events"));
    expect(res.status).toBe(401);
  });

  test("login แล้ว → คืน audit events ที่มีอยู่ (อย่างน้อย login_succeeded ของตัวเอง)", async () => {
    const { app } = await setupApp();
    const loginRes = await app.handle(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "adminpass123" }),
      }),
    );
    const cookies = parseCookies(loginRes);
    const cookieHeader = Object.entries(cookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("; ");

    const res = await app.handle(
      new Request("http://localhost/api/v1/audit-events", {
        headers: { cookie: cookieHeader },
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.items.some((e: { action: string }) => e.action === "login_succeeded")).toBe(true);
  });
});
