/**
 * Monitoring Routes API — HTTP round-trip tests
 * Phase 9 M3
 *
 * ครอบคลุม:
 * - GET /system/metrics → host series + latest
 * - GET /projects/:id/metrics → container series + latest
 * - range preset (1h/6h/24h) กรองช่วงเวลาจริง
 * - range ที่ไม่รู้จัก → 422 (ไม่ยอมรับ ms ดิบจาก client)
 * - downsample ไม่เกิน maxSeriesPoints และรักษายอดแหลม
 * - latest แสดงได้แม้ช่วงที่ขอไม่มีข้อมูล
 * - project ไม่มีอยู่ / archived → 404
 * - Unauthenticated → 401
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { MONITORING, ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { json } from "./helpers";

async function setup() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));

  const now = Date.now();
  const userId = ulid();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)",
  ).run(userId, await hashPassword("adminpass123"), now, now);

  const projectId = ulid();
  db.query(
    `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'metrics-test', 'running', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(projectId, now, now);

  const app = buildApp(db);

  const loginRes = await app.handle(
    new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "adminpass123" }),
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

  return { db, app, projectId, cookie, now };
}

type Db = Awaited<ReturnType<typeof setup>>["db"];

function insertHost(db: Db, ts: number, cpuPercent = 10) {
  db.query(
    `INSERT OR REPLACE INTO host_metrics
       (ts, cpu_percent, mem_used_bytes, mem_total_bytes,
        disk_used_bytes, disk_total_bytes, load1, load5, load15, cpu_count)
     VALUES (?, ?, 2000, 8000, 5000, 50000, 0.5, 0.4, 0.3, 4)`,
  ).run(ts, cpuPercent);
}

function insertContainer(db: Db, projectId: string, ts: number, cpuPercent = 5) {
  db.query(
    `INSERT OR REPLACE INTO container_metrics
       (ts, project_id, container_id, cpu_percent, mem_used_bytes, mem_limit_bytes, restart_count, running)
     VALUES (?, ?, 'c1', ?, 1000, 4000, 0, 1)`,
  ).run(ts, projectId, cpuPercent);
}

function get(app: ReturnType<typeof buildApp>, path: string, cookie?: string) {
  return app.handle(new Request(`http://localhost${path}`, { headers: cookie ? { cookie } : {} }));
}

// ---------------------------------------------------------------------------
// GET /system/metrics
// ---------------------------------------------------------------------------

describe("GET /api/v1/system/metrics", () => {
  test("คืน series + latest + range", async () => {
    const { app, db, cookie, now } = await setup();
    insertHost(db, now - 30_000, 20);
    insertHost(db, now - 15_000, 40);

    const res = await get(app, "/api/v1/system/metrics", cookie);
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.points).toHaveLength(2);
    expect(body.latest.cpuPercent).toBe(40);
    expect(body.latest.cpuCount).toBe(4);
    expect(body.range.sampleIntervalMs).toBe(MONITORING.sampleIntervalMs);
    expect(body.range.toTs).toBeGreaterThan(body.range.fromTs);
  });

  test("ยังไม่มีข้อมูลเลย → points ว่าง, latest เป็น null", async () => {
    const { app, cookie } = await setup();
    const body = await json(await get(app, "/api/v1/system/metrics", cookie));
    expect(body.points).toEqual([]);
    expect(body.latest).toBeNull();
  });

  test("range=1h ไม่รวมจุดที่เก่ากว่า 1 ชม.", async () => {
    const { app, db, cookie, now } = await setup();
    insertHost(db, now - 2 * 60 * 60 * 1000, 99); // 2 ชม.ที่แล้ว
    insertHost(db, now - 60_000, 11);

    const body = await json(await get(app, "/api/v1/system/metrics?range=1h", cookie));
    expect(body.points).toHaveLength(1);
    expect(body.points[0].cpuPercent).toBe(11);
  });

  test("range=24h รวมจุดที่ 1h ตัดทิ้ง", async () => {
    const { app, db, cookie, now } = await setup();
    insertHost(db, now - 2 * 60 * 60 * 1000, 99);
    insertHost(db, now - 60_000, 11);

    const body = await json(await get(app, "/api/v1/system/metrics?range=24h", cookie));
    expect(body.points).toHaveLength(2);
  });

  test("latest แสดงได้แม้ช่วงที่ขอไม่มีข้อมูล (เพิ่งรีสตาร์ท worker)", async () => {
    const { app, db, cookie, now } = await setup();
    insertHost(db, now - 5 * 60 * 60 * 1000, 77); // เก่ากว่า 1h

    const body = await json(await get(app, "/api/v1/system/metrics?range=1h", cookie));
    expect(body.points).toEqual([]);
    expect(body.latest.cpuPercent).toBe(77);
  });

  test("range ที่ไม่รู้จัก → 400 VALIDATION_ERROR (ไม่รับ ms ดิบจาก client)", async () => {
    const { app, cookie } = await setup();
    const res = await get(app, "/api/v1/system/metrics?range=999999", cookie);
    expect(res.status).toBe(400);
  });

  test("downsample ไม่เกิน maxSeriesPoints และเก็บยอดแหลมไว้", async () => {
    const { app, db, cookie, now } = await setup();
    const count = MONITORING.maxSeriesPoints * 3;
    for (let i = 0; i < count; i++) {
      insertHost(db, now - (count - i) * 1000, 1);
    }
    // ยอดแหลมกลางชุดข้อมูล — ต้องไม่หายหลัง downsample
    insertHost(db, now - Math.floor(count / 2) * 1000, 95);

    const body = await json(await get(app, "/api/v1/system/metrics?range=1h", cookie));
    expect(body.points.length).toBeLessThanOrEqual(MONITORING.maxSeriesPoints);
    expect(Math.max(...body.points.map((p: { cpuPercent: number }) => p.cpuPercent))).toBe(95);
  });

  test("points เรียงตามเวลาเสมอหลัง downsample", async () => {
    const { app, db, cookie, now } = await setup();
    for (let i = 0; i < MONITORING.maxSeriesPoints * 2; i++) {
      insertHost(db, now - i * 1000, i % 50);
    }

    const body = await json(await get(app, "/api/v1/system/metrics?range=1h", cookie));
    const timestamps = body.points.map((p: { ts: number }) => p.ts);
    expect(timestamps).toEqual([...timestamps].sort((a: number, b: number) => a - b));
  });

  test("ไม่ login → 401", async () => {
    const { app } = await setup();
    expect((await get(app, "/api/v1/system/metrics")).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /projects/:id/metrics
// ---------------------------------------------------------------------------

describe("GET /api/v1/projects/:id/metrics", () => {
  test("คืน container series + latest", async () => {
    const { app, db, cookie, projectId, now } = await setup();
    insertContainer(db, projectId, now - 30_000, 3);
    insertContainer(db, projectId, now - 15_000, 8);

    const res = await get(app, `/api/v1/projects/${projectId}/metrics`, cookie);
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.points).toHaveLength(2);
    expect(body.latest.cpuPercent).toBe(8);
    expect(body.latest.running).toBe(true);
    expect(body.latest.memLimitBytes).toBe(4000);
  });

  test("ไม่ปนข้อมูลจาก project อื่น", async () => {
    const { app, db, cookie, projectId, now } = await setup();
    const otherId = ulid();
    db.query(
      `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
       VALUES (?, 'other', 'running', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
    ).run(otherId, now, now);

    insertContainer(db, projectId, now - 10_000, 1);
    insertContainer(db, otherId, now - 10_000, 99);

    const body = await json(await get(app, `/api/v1/projects/${projectId}/metrics`, cookie));
    expect(body.points).toHaveLength(1);
    expect(body.points[0].cpuPercent).toBe(1);
  });

  test("project ยังไม่มี metrics → ว่างทั้งคู่ ไม่ error", async () => {
    const { app, cookie, projectId } = await setup();
    const body = await json(await get(app, `/api/v1/projects/${projectId}/metrics`, cookie));
    expect(body.points).toEqual([]);
    expect(body.latest).toBeNull();
  });

  test("project ไม่มีอยู่ → 404", async () => {
    const { app, cookie } = await setup();
    const res = await get(app, `/api/v1/projects/${ulid()}/metrics`, cookie);
    expect(res.status).toBe(404);
  });

  test("id ไม่ใช่ ULID → 404", async () => {
    const { app, cookie } = await setup();
    expect((await get(app, "/api/v1/projects/not-a-ulid/metrics", cookie)).status).toBe(404);
  });

  test("project ที่ archive แล้ว → 404", async () => {
    const { app, db, cookie, projectId } = await setup();
    db.query("UPDATE projects SET archived_at = ? WHERE id = ?").run(Date.now(), projectId);
    expect((await get(app, `/api/v1/projects/${projectId}/metrics`, cookie)).status).toBe(404);
  });

  test("ไม่ login → 401", async () => {
    const { app, projectId } = await setup();
    expect((await get(app, `/api/v1/projects/${projectId}/metrics`)).status).toBe(401);
  });
});
