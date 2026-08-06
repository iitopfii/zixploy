/**
 * Migration 0007 (environment_variables) — schema-level constraint tests
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
  const projectId = "01JPROJECTENV0000000000000";
  db.query(
    `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'env-test', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(projectId, now, now);

  return { db, projectId, now };
}

const ID1 = "01JENV0000000000000000001";
const ID2 = "01JENV0000000000000000002";

describe("migration 0007 — environment_variables", () => {
  test("insert พื้นฐานสำเร็จและ default ถูกต้อง", () => {
    const { db, projectId, now } = setup();
    db.query(
      `INSERT INTO environment_variables (id, project_id, key, value_ciphertext, created_at, updated_at)
       VALUES (?, ?, 'DATABASE_URL', X'deadbeef', ?, ?)`,
    ).run(ID1, projectId, now, now);

    const row = db
      .query<{ is_secret: number; scope: string; enabled: number; version: number }, [string]>(
        "SELECT is_secret, scope, enabled, version FROM environment_variables WHERE id = ?",
      )
      .get(ID1);

    expect(row?.is_secret).toBe(0);
    expect(row?.scope).toBe("runtime");
    expect(row?.enabled).toBe(1);
    expect(row?.version).toBe(1);
  });

  test("scope ต้องเป็น runtime | build | both เท่านั้น", () => {
    const { db, projectId, now } = setup();
    expect(() => {
      db.query(
        `INSERT INTO environment_variables (id, project_id, key, value_ciphertext, scope, created_at, updated_at)
         VALUES (?, ?, 'KEY', X'deadbeef', 'production', ?, ?)`,
      ).run(ID1, projectId, now, now);
    }).toThrow();
  });

  test("scope='build' และ scope='both' ใช้ได้", () => {
    const { db, projectId, now } = setup();
    db.query(
      `INSERT INTO environment_variables (id, project_id, key, value_ciphertext, scope, created_at, updated_at)
       VALUES (?, ?, 'BUILD_ARG', X'01', 'build', ?, ?)`,
    ).run(ID1, projectId, now, now);
    db.query(
      `INSERT INTO environment_variables (id, project_id, key, value_ciphertext, scope, created_at, updated_at)
       VALUES (?, ?, 'BOTH_VAR', X'02', 'both', ?, ?)`,
    ).run(ID2, projectId, now, now);

    const count = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) as n FROM environment_variables WHERE project_id = ?",
      )
      .get(projectId)!.n;
    expect(count).toBe(2);
  });

  test("UNIQUE(project_id, key) — key ซ้ำใน project เดียวกันถูกปฏิเสธ", () => {
    const { db, projectId, now } = setup();
    db.query(
      `INSERT INTO environment_variables (id, project_id, key, value_ciphertext, created_at, updated_at)
       VALUES (?, ?, 'DUPLICATE', X'01', ?, ?)`,
    ).run(ID1, projectId, now, now);

    expect(() => {
      db.query(
        `INSERT INTO environment_variables (id, project_id, key, value_ciphertext, created_at, updated_at)
         VALUES (?, ?, 'DUPLICATE', X'02', ?, ?)`,
      ).run(ID2, projectId, now, now);
    }).toThrow(/UNIQUE constraint/i);
  });

  test("key เดียวกันใน project ต่างกัน → ไม่ชนกัน", () => {
    const { db, now } = setup();
    // สร้าง project ที่สอง
    const projectId2 = "01JPROJECTENV0000000000002";
    db.query(
      `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
       VALUES (?, 'env-test-2', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
    ).run(projectId2, now, now);

    const projectId1 = "01JPROJECTENV0000000000000";
    db.query(
      `INSERT INTO environment_variables (id, project_id, key, value_ciphertext, created_at, updated_at)
       VALUES (?, ?, 'SHARED_KEY', X'01', ?, ?)`,
    ).run(ID1, projectId1, now, now);

    // ไม่ throw — คนละ project
    db.query(
      `INSERT INTO environment_variables (id, project_id, key, value_ciphertext, created_at, updated_at)
       VALUES (?, ?, 'SHARED_KEY', X'02', ?, ?)`,
    ).run(ID2, projectId2, now, now);

    const total = db
      .query<{ n: number }, []>("SELECT COUNT(*) as n FROM environment_variables")
      .get()!.n;
    expect(total).toBe(2);
  });

  test("project_id FK enforced — project ไม่มีอยู่จริง → throw", () => {
    const { db, now } = setup();
    expect(() => {
      db.query(
        `INSERT INTO environment_variables (id, project_id, key, value_ciphertext, created_at, updated_at)
         VALUES (?, 'nonexistent', 'KEY', X'01', ?, ?)`,
      ).run(ID1, now, now);
    }).toThrow();
  });

  test("value_ciphertext เก็บเป็น BLOB — binary data ไม่เปลี่ยนแปลง", () => {
    const { db, projectId, now } = setup();
    const binary = new Uint8Array([0x01, 0xde, 0xad, 0xbe, 0xef, 0xff, 0x00, 0x42]);
    db.query(
      `INSERT INTO environment_variables (id, project_id, key, value_ciphertext, created_at, updated_at)
       VALUES (?, ?, 'BLOB_TEST', ?, ?, ?)`,
    ).run(ID1, projectId, binary, now, now);

    const row = db
      .query<{ value_ciphertext: Buffer }, [string]>(
        "SELECT value_ciphertext FROM environment_variables WHERE id = ?",
      )
      .get(ID1);
    expect(row?.value_ciphertext).toEqual(Buffer.from(binary));
  });

  test("idx_env_vars_project index ถูกสร้าง", () => {
    const { db } = setup();
    const row = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name=?",
      )
      .get("idx_env_vars_project");
    expect(row?.name).toBe("idx_env_vars_project");
  });
});
