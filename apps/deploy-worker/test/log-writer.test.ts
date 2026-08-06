/**
 * makeBuildLogger — unit tests (docs/phase-06-logs.md M2)
 *
 * ครอบคลุม:
 * - seq เริ่มจาก 1 เมื่อไม่มี row อยู่ก่อน
 * - seq เพิ่มทีละ 1 ทุกการเรียก log()
 * - เริ่ม seq ต่อจาก row ล่าสุด (idempotent เมื่อ restart)
 * - stream default เป็น stdout; สามารถส่ง stderr ได้
 * - write failure ไม่ throw (graceful degradation)
 * - deployment แต่ละอันมี seq เป็นของตัวเอง
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { makeBuildLogger } from "../src/logs/writer";

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
     VALUES (?, 'test', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(id, now, now);
  return id;
}

function insertDeployment(db: ReturnType<typeof makeDb>, projectId: string): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
     VALUES (?, ?, 'building', 'push', 'abc123', ?, ?, ?)`,
  ).run(id, projectId, now, now, now);
  return id;
}

function getLogRows(db: ReturnType<typeof makeDb>, deploymentId: string) {
  return db
    .query<{ seq: number; stream: string; line: string }, [string]>(
      "SELECT seq, stream, line FROM build_logs WHERE deployment_id = ? ORDER BY seq ASC",
    )
    .all(deploymentId);
}

function countLogs(db: ReturnType<typeof makeDb>, deploymentId: string): number {
  return db
    .query<{ cnt: number }, [string]>(
      "SELECT COUNT(*) as cnt FROM build_logs WHERE deployment_id = ?",
    )
    .get(deploymentId)!.cnt;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("makeBuildLogger — seq numbering", () => {
  test("seq เริ่มจาก 1 เมื่อไม่มี row อยู่ก่อน", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);

    const logger = makeBuildLogger(db, deploymentId);
    logger.log("first line");

    const rows = getLogRows(db, deploymentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seq).toBe(1);
  });

  test("seq เพิ่มทีละ 1 ทุกการเรียก", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);

    const logger = makeBuildLogger(db, deploymentId);
    logger.log("line A");
    logger.log("line B");
    logger.log("line C");

    const rows = getLogRows(db, deploymentId);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.line)).toEqual(["line A", "line B", "line C"]);
  });

  test("seq เริ่มต่อจาก row ล่าสุดเมื่อมีข้อมูลอยู่แล้ว (idempotent restart)", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);

    // pre-insert 3 rows (จำลองว่า worker เคย write แล้ว)
    const now = Date.now();
    for (let i = 1; i <= 3; i++) {
      db.query(
        `INSERT INTO build_logs (id, deployment_id, seq, line, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(ulid(), deploymentId, i, `old line ${i}`, now);
    }

    // สร้าง logger ใหม่ (จำลอง worker restart) ต้อง continue จาก seq 4
    const logger = makeBuildLogger(db, deploymentId);
    logger.log("new line after restart");

    const rows = getLogRows(db, deploymentId);
    expect(rows).toHaveLength(4);
    expect(rows[3]!.seq).toBe(4);
    expect(rows[3]!.line).toBe("new line after restart");
  });
});

describe("makeBuildLogger — stream", () => {
  test("stream default เป็น stdout", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);

    makeBuildLogger(db, deploymentId).log("default stream");

    const rows = getLogRows(db, deploymentId);
    expect(rows[0]!.stream).toBe("stdout");
  });

  test("สามารถระบุ stderr ได้", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);

    const logger = makeBuildLogger(db, deploymentId);
    logger.log("stdout line", "stdout");
    logger.log("stderr line", "stderr");

    const rows = getLogRows(db, deploymentId);
    expect(rows[0]!.stream).toBe("stdout");
    expect(rows[1]!.stream).toBe("stderr");
  });
});

describe("makeBuildLogger — graceful degradation", () => {
  test("write ที่ล้มเหลว (deployment ไม่มี) ไม่ throw", () => {
    const db = makeDb();
    // ไม่ insert deployment — FK จะ fail ตอน insert build_logs
    const fakeDeploymentId = ulid();

    const logger = makeBuildLogger(db, fakeDeploymentId);
    // ไม่ควร throw
    expect(() => {
      logger.log("this should not throw");
    }).not.toThrow();
  });
});

describe("makeBuildLogger — deployment isolation", () => {
  test("deployment แต่ละอันมี seq เป็นของตัวเอง", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const dep1 = insertDeployment(db, projectId);
    const dep2 = insertDeployment(db, projectId);

    const loggerA = makeBuildLogger(db, dep1);
    const loggerB = makeBuildLogger(db, dep2);

    loggerA.log("A1");
    loggerA.log("A2");
    loggerB.log("B1");

    const rowsA = getLogRows(db, dep1);
    const rowsB = getLogRows(db, dep2);

    expect(rowsA.map((r) => r.seq)).toEqual([1, 2]);
    expect(rowsB.map((r) => r.seq)).toEqual([1]);
    expect(countLogs(db, dep1)).toBe(2);
    expect(countLogs(db, dep2)).toBe(1);
  });
});
