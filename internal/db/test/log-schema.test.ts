/**
 * Migration 0009 (build_logs, runtime_logs) — schema-level constraint tests
 */
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/connection";
import { loadMigrations, migrateUp } from "../src/migrate";
import { migrationsDir } from "../src/paths";

const PROJECT_ID = "01JLOGSCHEMAPROJ00000000001";
const DEPLOYMENT_ID = "01JLOGSCHEMADEV00000000001";

function setup() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  const now = Date.now();

  db.query(
    `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'log-test', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(PROJECT_ID, now, now);

  db.query(
    `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
     VALUES (?, ?, 'succeeded', 'push', 'abc123', ?, ?, ?)`,
  ).run(DEPLOYMENT_ID, PROJECT_ID, now, now, now);

  return { db, now };
}

// ---------------------------------------------------------------------------
// build_logs
// ---------------------------------------------------------------------------

describe("migration 0009 — build_logs", () => {
  test("insert พื้นฐานสำเร็จและ defaults ถูกต้อง", () => {
    const { db, now } = setup();
    db.query(
      `INSERT INTO build_logs (id, deployment_id, seq, line, created_at)
       VALUES ('LOG1', ?, 1, 'hello', ?)`,
    ).run(DEPLOYMENT_ID, now);

    const row = db
      .query<{ stream: string; seq: number; line: string }, [string]>(
        "SELECT stream, seq, line FROM build_logs WHERE id = ?",
      )
      .get("LOG1");

    expect(row?.stream).toBe("stdout");
    expect(row?.seq).toBe(1);
    expect(row?.line).toBe("hello");
  });

  test("UNIQUE (deployment_id, seq) ป้องกัน seq ซ้ำ", () => {
    const { db, now } = setup();
    db.query(
      `INSERT INTO build_logs (id, deployment_id, seq, line, created_at)
       VALUES ('LOG1', ?, 1, 'first', ?)`,
    ).run(DEPLOYMENT_ID, now);

    expect(() => {
      db.query(
        `INSERT INTO build_logs (id, deployment_id, seq, line, created_at)
         VALUES ('LOG2', ?, 1, 'dup', ?)`,
      ).run(DEPLOYMENT_ID, now);
    }).toThrow(/UNIQUE/);
  });

  test("stream CHECK ยอมรับแค่ stdout/stderr", () => {
    const { db, now } = setup();

    expect(() => {
      db.query(
        `INSERT INTO build_logs (id, deployment_id, seq, stream, line, created_at)
         VALUES ('LOGX', ?, 99, 'stdin', 'bad', ?)`,
      ).run(DEPLOYMENT_ID, now);
    }).toThrow(/CHECK/);

    // stdout และ stderr ต้องผ่าน
    db.query(
      `INSERT INTO build_logs (id, deployment_id, seq, stream, line, created_at)
       VALUES ('LOGA', ?, 1, 'stderr', 'err line', ?)`,
    ).run(DEPLOYMENT_ID, now);
    const r = db
      .query<{ stream: string }, [string]>("SELECT stream FROM build_logs WHERE id = ?")
      .get("LOGA");
    expect(r?.stream).toBe("stderr");
  });

  test("ON DELETE CASCADE — ลบ deployment แล้ว build_logs หายด้วย", () => {
    const { db, now } = setup();
    db.query(
      `INSERT INTO build_logs (id, deployment_id, seq, line, created_at)
       VALUES ('LOG1', ?, 1, 'line', ?)`,
    ).run(DEPLOYMENT_ID, now);

    // ลบ deployment
    db.query("DELETE FROM deployments WHERE id = ?").run(DEPLOYMENT_ID);

    const count = db.query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM build_logs").get()!;
    expect(count.cnt).toBe(0);
  });

  test("seq หลาย row เรียงได้ถูกต้อง", () => {
    const { db, now } = setup();
    for (let i = 10; i >= 1; i--) {
      db.query(
        `INSERT INTO build_logs (id, deployment_id, seq, line, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(`LOG${i}`, DEPLOYMENT_ID, i, `line${i}`, now);
    }
    const rows = db
      .query<{ seq: number }, [string]>(
        "SELECT seq FROM build_logs WHERE deployment_id = ? ORDER BY seq ASC",
      )
      .all(DEPLOYMENT_ID);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("FK ป้องกัน deployment ที่ไม่มีอยู่", () => {
    const { db, now } = setup();
    expect(() => {
      db.query(
        `INSERT INTO build_logs (id, deployment_id, seq, line, created_at)
         VALUES ('LOGX', 'NONEXISTENT', 1, 'x', ?)`,
      ).run(now);
    }).toThrow(/FOREIGN KEY/);
  });

  test("index idx_build_logs_deployment_seq มีอยู่", () => {
    const { db } = setup();
    const rows = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index'")
      .all();
    const names = rows.map((r) => r.name);
    expect(names).toContain("idx_build_logs_deployment_seq");
  });
});

// ---------------------------------------------------------------------------
// runtime_logs
// ---------------------------------------------------------------------------

describe("migration 0009 — runtime_logs", () => {
  test("insert พื้นฐานสำเร็จและ defaults ถูกต้อง", () => {
    const { db, now } = setup();
    db.query(
      `INSERT INTO runtime_logs (id, project_id, container_id, seq, line, logged_at, created_at)
       VALUES ('RL1', ?, 'c123', 1, 'hello', ?, ?)`,
    ).run(PROJECT_ID, now, now);

    const row = db
      .query<{ stream: string; container_id: string }, [string]>(
        "SELECT stream, container_id FROM runtime_logs WHERE id = ?",
      )
      .get("RL1");

    expect(row?.stream).toBe("stdout");
    expect(row?.container_id).toBe("c123");
  });

  test("UNIQUE (project_id, seq) ป้องกัน seq ซ้ำ", () => {
    const { db, now } = setup();
    db.query(
      `INSERT INTO runtime_logs (id, project_id, container_id, seq, line, logged_at, created_at)
       VALUES ('RL1', ?, 'c1', 1, 'l1', ?, ?)`,
    ).run(PROJECT_ID, now, now);

    expect(() => {
      db.query(
        `INSERT INTO runtime_logs (id, project_id, container_id, seq, line, logged_at, created_at)
         VALUES ('RL2', ?, 'c1', 1, 'dup', ?, ?)`,
      ).run(PROJECT_ID, now, now);
    }).toThrow(/UNIQUE/);
  });

  test("stream CHECK ยอมรับแค่ stdout/stderr", () => {
    const { db, now } = setup();
    expect(() => {
      db.query(
        `INSERT INTO runtime_logs (id, project_id, container_id, seq, stream, line, logged_at, created_at)
         VALUES ('RLX', ?, 'c1', 1, 'debug', 'bad', ?, ?)`,
      ).run(PROJECT_ID, now, now);
    }).toThrow(/CHECK/);
  });

  test("ON DELETE CASCADE — ลบ project (และ deployment ก่อน) แล้ว runtime_logs หายด้วย", () => {
    const { db, now } = setup();
    db.query(
      `INSERT INTO runtime_logs (id, project_id, container_id, seq, line, logged_at, created_at)
       VALUES ('RL1', ?, 'c1', 1, 'line', ?, ?)`,
    ).run(PROJECT_ID, now, now);

    // ต้องลบ deployment ก่อน (deployments FK → projects ไม่ใช่ cascade)
    db.query("DELETE FROM deployments WHERE project_id = ?").run(PROJECT_ID);
    db.query("DELETE FROM projects WHERE id = ?").run(PROJECT_ID);

    const count = db.query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM runtime_logs").get()!;
    expect(count.cnt).toBe(0);
  });

  test("index idx_runtime_logs_project_seq มีอยู่", () => {
    const { db } = setup();
    const rows = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index'")
      .all();
    const names = rows.map((r) => r.name);
    expect(names).toContain("idx_runtime_logs_project_seq");
  });
});
