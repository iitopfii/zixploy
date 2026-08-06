/**
 * Log retention — unit tests (docs/phase-06-logs.md M5)
 *
 * ครอบคลุม:
 * - pruneBuildLogs: ลบ log ของ deployment ที่ terminal + finished_at เกิน threshold
 * - pruneBuildLogs: ไม่ลบ log ของ deployment ที่กำลัง build / ยังไม่ถึง threshold
 * - pruneRuntimeLogs: ring buffer truncation ต่อ project
 * - pruneRuntimeLogs: ไม่ล้นระหว่าง project
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { pruneBuildLogs, pruneRuntimeLogs } from "../src/logs/retention";

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function insertProject(db: ReturnType<typeof makeDb>): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO projects
      (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'p', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(id, now, now);
  return id;
}

function insertDeployment(
  db: ReturnType<typeof makeDb>,
  projectId: string,
  opts: { status: string; finishedAt?: number },
): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO deployments
       (id, project_id, status, trigger, commit_sha, queued_at, finished_at, created_at, updated_at)
     VALUES (?, ?, ?, 'push', 'abc', ?, ?, ?, ?)`,
  ).run(id, projectId, opts.status, now, opts.finishedAt ?? null, now, now);
  return id;
}

function insertBuildLog(
  db: ReturnType<typeof makeDb>,
  deploymentId: string,
  seq: number,
): void {
  db.query(
    `INSERT INTO build_logs (id, deployment_id, seq, line, created_at) VALUES (?, ?, ?, 'x', ?)`,
  ).run(ulid(), deploymentId, seq, Date.now());
}

function insertRuntimeLog(
  db: ReturnType<typeof makeDb>,
  projectId: string,
  seq: number,
): void {
  const now = Date.now();
  db.query(
    `INSERT INTO runtime_logs (id, project_id, container_id, seq, stream, line, logged_at, created_at)
     VALUES (?, ?, 'c1', ?, 'stdout', 'x', ?, ?)`,
  ).run(ulid(), projectId, seq, now, now);
}

function countBuildLogs(db: ReturnType<typeof makeDb>, deploymentId: string): number {
  return db
    .query<{ cnt: number }, [string]>(
      "SELECT COUNT(*) as cnt FROM build_logs WHERE deployment_id = ?",
    )
    .get(deploymentId)!.cnt;
}

function countRuntimeLogs(db: ReturnType<typeof makeDb>, projectId: string): number {
  return db
    .query<{ cnt: number }, [string]>(
      "SELECT COUNT(*) as cnt FROM runtime_logs WHERE project_id = ?",
    )
    .get(projectId)!.cnt;
}

// ---------------------------------------------------------------------------
// pruneBuildLogs
// ---------------------------------------------------------------------------

describe("pruneBuildLogs", () => {
  test("ลบ log ของ terminal deployment ที่ finished_at เกิน threshold", () => {
    const db = makeDb();
    const projectId = insertProject(db);

    // deployment ที่ expire แล้ว (31 วันก่อน)
    const oldFinish = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const oldDepId = insertDeployment(db, projectId, { status: "succeeded", finishedAt: oldFinish });
    insertBuildLog(db, oldDepId, 1);
    insertBuildLog(db, oldDepId, 2);

    const deleted = pruneBuildLogs(db, 30);
    expect(deleted).toBe(2);
    expect(countBuildLogs(db, oldDepId)).toBe(0);
  });

  test("ไม่ลบ log ของ deployment ที่ finished_at ยังไม่ถึง threshold", () => {
    const db = makeDb();
    const projectId = insertProject(db);

    // deployment ที่เพิ่ง finish (1 วันก่อน)
    const recentFinish = Date.now() - 1 * 24 * 60 * 60 * 1000;
    const recentDepId = insertDeployment(db, projectId, {
      status: "succeeded",
      finishedAt: recentFinish,
    });
    insertBuildLog(db, recentDepId, 1);

    const deleted = pruneBuildLogs(db, 30);
    expect(deleted).toBe(0);
    expect(countBuildLogs(db, recentDepId)).toBe(1);
  });

  test("ไม่ลบ log ของ deployment ที่กำลัง build (non-terminal)", () => {
    const db = makeDb();
    const projectId = insertProject(db);

    // deployment ที่ยัง building
    const buildingDepId = insertDeployment(db, projectId, { status: "building" });
    insertBuildLog(db, buildingDepId, 1);

    const deleted = pruneBuildLogs(db, 0); // retention = 0 days (ลบทุกอย่างที่ terminal)
    expect(deleted).toBe(0); // non-terminal ต้องรอด
    expect(countBuildLogs(db, buildingDepId)).toBe(1);
  });

  test("ลบเฉพาะ deployment ที่ expire ไม่แตะที่ยังใหม่", () => {
    const db = makeDb();
    const projectId = insertProject(db);

    const oldFinish = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const oldDepId = insertDeployment(db, projectId, { status: "failed", finishedAt: oldFinish });
    insertBuildLog(db, oldDepId, 1);

    const recentFinish = Date.now() - 1 * 24 * 60 * 60 * 1000;
    const recentDepId = insertDeployment(db, projectId, {
      status: "succeeded",
      finishedAt: recentFinish,
    });
    insertBuildLog(db, recentDepId, 1);

    pruneBuildLogs(db, 30);

    expect(countBuildLogs(db, oldDepId)).toBe(0);
    expect(countBuildLogs(db, recentDepId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// pruneRuntimeLogs
// ---------------------------------------------------------------------------

describe("pruneRuntimeLogs", () => {
  test("ไม่ลบเมื่อจำนวน row ไม่เกิน ringSize", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    for (let i = 1; i <= 5; i++) insertRuntimeLog(db, projectId, i);

    const deleted = pruneRuntimeLogs(db, projectId, 10);
    expect(deleted).toBe(0);
    expect(countRuntimeLogs(db, projectId)).toBe(5);
  });

  test("ลบ row เก่าให้เหลือ ringSize เมื่อเกิน", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    for (let i = 1; i <= 15; i++) insertRuntimeLog(db, projectId, i);

    pruneRuntimeLogs(db, projectId, 10);
    expect(countRuntimeLogs(db, projectId)).toBeLessThanOrEqual(10);

    // row ที่มี seq สูงสุด (ใหม่สุด) ต้องรอด
    const rows = db
      .query<{ seq: number }, [string]>(
        "SELECT seq FROM runtime_logs WHERE project_id = ? ORDER BY seq DESC",
      )
      .all(projectId);
    expect(rows[0]!.seq).toBe(15);
  });

  test("ไม่แตะ runtime_logs ของ project อื่น", () => {
    const db = makeDb();
    const p1 = insertProject(db);
    const p2 = insertProject(db);

    for (let i = 1; i <= 15; i++) insertRuntimeLog(db, p1, i);
    for (let i = 1; i <= 5; i++) insertRuntimeLog(db, p2, i);

    pruneRuntimeLogs(db, p1, 10);

    expect(countRuntimeLogs(db, p1)).toBeLessThanOrEqual(10);
    expect(countRuntimeLogs(db, p2)).toBe(5); // ไม่ถูกแตะ
  });
});
