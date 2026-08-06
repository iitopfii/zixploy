/**
 * Migration 0006 (deployments + deploy_jobs) — schema-level constraint tests
 * ไม่มี app code ที่ milestone นี้ — ทดสอบ DDL โดยตรงผ่าน raw SQL
 */
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/connection";
import { loadMigrations, migrateUp } from "../src/migrate";
import { migrationsDir } from "../src/paths";

function setup() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));

  const now = Date.now();
  const projectId = "01JPROJECTID000000000000000";
  db.query(
    `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'test', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(projectId, now, now);

  return { db, projectId, now };
}

describe("migration 0006 — deployments table", () => {
  test("status ต้องอยู่ใน enum ที่กำหนด — ค่าอื่นถูกปฏิเสธ", () => {
    const { db, projectId, now } = setup();
    expect(() => {
      db.query(
        `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
         VALUES ('01JDEPLOY0000000000000000A', ?, 'not_a_real_status', 'push', ?, ?, ?, ?)`,
      ).run(projectId, "a".repeat(40), now, now, now);
    }).toThrow();
  });

  test("trigger ต้องอยู่ใน enum ที่กำหนด", () => {
    const { db, projectId, now } = setup();
    expect(() => {
      db.query(
        `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
         VALUES ('01JDEPLOY0000000000000000B', ?, 'queued', 'bogus_trigger', ?, ?, ?, ?)`,
      ).run(projectId, "a".repeat(40), now, now, now);
    }).toThrow();
  });

  test("insert ปกติสำเร็จด้วยค่า default status='queued'", () => {
    const { db, projectId, now } = setup();
    db.query(
      `INSERT INTO deployments (id, project_id, trigger, commit_sha, queued_at, created_at, updated_at)
       VALUES ('01JDEPLOY0000000000000000C', ?, 'push', ?, ?, ?, ?)`,
    ).run(projectId, "a".repeat(40), now, now, now);

    const row = db
      .query<{ status: string }, [string]>("SELECT status FROM deployments WHERE id = ?")
      .get("01JDEPLOY0000000000000000C");
    expect(row?.status).toBe("queued");
  });

  test("project_id ต้องมีอยู่จริง (FK enforced)", () => {
    const { db, now } = setup();
    expect(() => {
      db.query(
        `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
         VALUES ('01JDEPLOY0000000000000000D', 'nonexistent-project', 'queued', 'push', ?, ?, ?, ?)`,
      ).run("a".repeat(40), now, now, now);
    }).toThrow();
  });
});

describe("migration 0006 — deploy_jobs table", () => {
  test("type ต้องเป็น deploy หรือ cleanup เท่านั้น", () => {
    const { db, projectId, now } = setup();
    expect(() => {
      db.query(
        `INSERT INTO deploy_jobs (id, project_id, type, payload, created_at, updated_at)
         VALUES ('01JJOB00000000000000000A', ?, 'not_a_type', '{}', ?, ?)`,
      ).run(projectId, now, now);
    }).toThrow();
  });

  test("status ต้องอยู่ใน enum ที่กำหนด", () => {
    const { db, projectId, now } = setup();
    expect(() => {
      db.query(
        `INSERT INTO deploy_jobs (id, project_id, type, status, payload, created_at, updated_at)
         VALUES ('01JJOB00000000000000000B', ?, 'deploy', 'bogus', '{}', ?, ?)`,
      ).run(projectId, now, now);
    }).toThrow();
  });

  test("UNIQUE INDEX: 2 pending job สำหรับ project+type เดียวกัน → insert ที่สองล้มเหลว", () => {
    const { db, projectId, now } = setup();
    db.query(
      `INSERT INTO deploy_jobs (id, project_id, type, status, payload, created_at, updated_at)
       VALUES ('01JJOB00000000000000000C', ?, 'deploy', 'pending', '{}', ?, ?)`,
    ).run(projectId, now, now);

    expect(() => {
      db.query(
        `INSERT INTO deploy_jobs (id, project_id, type, status, payload, created_at, updated_at)
         VALUES ('01JJOB00000000000000000D', ?, 'deploy', 'pending', '{}', ?, ?)`,
      ).run(projectId, now, now);
    }).toThrow();
  });

  test("pending และ leased อยู่คู่กันได้พร้อมกัน (2 partial index แยกกัน)", () => {
    const { db, projectId, now } = setup();
    db.query(
      `INSERT INTO deploy_jobs (id, project_id, type, status, payload, lease_owner, lease_expires_at, created_at, updated_at)
       VALUES ('01JJOB00000000000000000E', ?, 'deploy', 'leased', '{}', 'worker-1', ?, ?, ?)`,
    ).run(projectId, now + 60_000, now, now);

    // ไม่ throw — pending คิวต่อหลัง leased ได้ตามที่ design ไว้ (coalesce ต่อไป)
    db.query(
      `INSERT INTO deploy_jobs (id, project_id, type, status, payload, created_at, updated_at)
       VALUES ('01JJOB00000000000000000F', ?, 'deploy', 'pending', '{}', ?, ?)`,
    ).run(projectId, now, now);

    const count = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM deploy_jobs WHERE project_id = ?")
      .get(projectId)!.n;
    expect(count).toBe(2);
  });

  test("2 leased job สำหรับ project+type เดียวกัน → insert ที่สองล้มเหลว", () => {
    const { db, projectId, now } = setup();
    db.query(
      `INSERT INTO deploy_jobs (id, project_id, type, status, payload, lease_owner, lease_expires_at, created_at, updated_at)
       VALUES ('01JJOB00000000000000000G', ?, 'deploy', 'leased', '{}', 'worker-1', ?, ?, ?)`,
    ).run(projectId, now + 60_000, now, now);

    expect(() => {
      db.query(
        `INSERT INTO deploy_jobs (id, project_id, type, status, payload, lease_owner, lease_expires_at, created_at, updated_at)
         VALUES ('01JJOB00000000000000000H', ?, 'deploy', 'leased', '{}', 'worker-2', ?, ?, ?)`,
      ).run(projectId, now + 60_000, now, now);
    }).toThrow();
  });

  test("job คนละ type (deploy vs cleanup) ไม่ชนกัน แม้ทั้งคู่ pending", () => {
    const { db, projectId, now } = setup();
    db.query(
      `INSERT INTO deploy_jobs (id, project_id, type, status, payload, created_at, updated_at)
       VALUES ('01JJOB00000000000000000I', ?, 'deploy', 'pending', '{}', ?, ?)`,
    ).run(projectId, now, now);

    // ไม่ throw — คนละ type
    db.query(
      `INSERT INTO deploy_jobs (id, project_id, type, status, payload, created_at, updated_at)
       VALUES ('01JJOB00000000000000000J', ?, 'cleanup', 'pending', '{}', ?, ?)`,
    ).run(projectId, now, now);

    const count = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM deploy_jobs WHERE project_id = ?")
      .get(projectId)!.n;
    expect(count).toBe(2);
  });

  test("job status='done'/'failed'/'cancelled' ไม่ถูกจำกัดโดย unique index — สร้างซ้ำได้เรื่อย ๆ", () => {
    const { db, projectId, now } = setup();
    for (let i = 0; i < 3; i++) {
      db.query(
        `INSERT INTO deploy_jobs (id, project_id, type, status, payload, created_at, updated_at)
         VALUES (?, ?, 'deploy', 'done', '{}', ?, ?)`,
      ).run(`01JJOBDONE00000000000000${i}`, projectId, now, now);
    }
    const count = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM deploy_jobs WHERE project_id = ?")
      .get(projectId)!.n;
    expect(count).toBe(3);
  });

  test("deployment_id FK nullable — job สร้างได้โดยไม่ต้องมี deployment", () => {
    const { db, projectId, now } = setup();
    db.query(
      `INSERT INTO deploy_jobs (id, project_id, type, status, payload, created_at, updated_at)
       VALUES ('01JJOBNODEP0000000000000A', ?, 'cleanup', 'pending', '{}', ?, ?)`,
    ).run(projectId, now, now);

    const row = db
      .query<{ deployment_id: string | null }, [string]>(
        "SELECT deployment_id FROM deploy_jobs WHERE id = ?",
      )
      .get("01JJOBNODEP0000000000000A");
    expect(row?.deployment_id).toBeNull();
  });

  test("project_id ต้องมีอยู่จริง (FK enforced)", () => {
    const { db, now } = setup();
    expect(() => {
      db.query(
        `INSERT INTO deploy_jobs (id, project_id, type, status, payload, created_at, updated_at)
         VALUES ('01JJOBBADPROJ00000000000A', 'nonexistent-project', 'deploy', 'pending', '{}', ?, ?)`,
      ).run(now, now);
    }).toThrow();
  });

  test("default attempts=0, max_attempts=1, priority=0", () => {
    const { db, projectId, now } = setup();
    db.query(
      `INSERT INTO deploy_jobs (id, project_id, type, payload, created_at, updated_at)
       VALUES ('01JJOBDEFAULTS000000000A', ?, 'deploy', '{}', ?, ?)`,
    ).run(projectId, now, now);

    const row = db
      .query<{ attempts: number; max_attempts: number; priority: number }, [string]>(
        "SELECT attempts, max_attempts, priority FROM deploy_jobs WHERE id = ?",
      )
      .get("01JJOBDEFAULTS000000000A");
    expect(row?.attempts).toBe(0);
    expect(row?.max_attempts).toBe(1);
    expect(row?.priority).toBe(0);
  });
});
