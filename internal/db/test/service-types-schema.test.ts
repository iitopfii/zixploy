/**
 * Migration 0029 (services.type เพิ่ม pgvector/minio/clamav) — schema-level tests
 *
 * จุดที่พลาดแล้วข้อมูลหายจริง: rebuild ตาราง services ตอน foreign_keys เปิดอยู่จะ cascade ลบ
 * backup/log/job/terminal ของทุก service — เทสต์จึงสร้างข้อมูลลูกไว้ก่อน migrate แล้วตรวจว่ายังอยู่ครบ
 *
 * ครอบคลุม:
 * - directive `-- migrate:disable-foreign-keys` ถูก parse และ foreign_keys กลับมาเปิดหลังรัน
 * - ชนิดใหม่ insert ได้ ชนิดมั่วยังถูก CHECK ปฏิเสธ
 * - แถวลูกของ service เดิมอยู่ครบหลัง migrate up
 * - rollback ทิ้งเฉพาะ service ชนิดใหม่และแถวลูกของมัน โดยไม่เหลือ orphan
 * - migration ที่ทิ้ง foreign key violation ไว้ถูก rollback ทั้งไฟล์
 */

import { describe, expect, test } from "bun:test";
import {
  loadMigrations,
  migrateDown,
  migrateUp,
  migrationsDir,
  openDatabase,
  parseMigrationFile,
} from "../src";

const all = loadMigrations(migrationsDir());
const before0029 = all.filter((m) => m.version < "0029");

type Db = ReturnType<typeof openDatabase>;

function insertService(db: Db, id: string, type: string, name = id) {
  db.query(
    `INSERT INTO services
       (id, name, type, version, image, status, volume_name, username, database_name,
        internal_port, created_at, updated_at, backup_enabled, backup_retention_count)
     VALUES (?, ?, ?, 'v', 'img:v', 'running', ?, 'u', 'd', 5432, 1, 1, 1, 5)`,
  ).run(id, name, type, `vol-${id}`);
}

function insertChildren(db: Db, serviceId: string) {
  db.query(
    `INSERT INTO service_jobs (id, service_id, type, status, created_at, updated_at)
     VALUES (?, ?, 'backup', 'done', 1, 1)`,
  ).run(`job-${serviceId}`, serviceId);
  db.query(
    `INSERT INTO service_backups (id, service_id, trigger, status, file_name, started_at, created_at)
     VALUES (?, ?, 'manual', 'succeeded', 'a.sql', 1, 1)`,
  ).run(`bak-${serviceId}`, serviceId);
  db.query(
    `INSERT INTO service_logs (id, service_id, container_id, seq, line, logged_at, created_at)
     VALUES (?, ?, 'c1', 1, 'hello', 1, 1)`,
  ).run(`log-${serviceId}`, serviceId);
  db.query(
    `INSERT INTO terminal_sessions (id, service_id, status, created_at)
     VALUES (?, ?, 'closed', 1)`,
  ).run(`term-${serviceId}`, serviceId);
}

function count(db: Db, table: string, serviceId: string): number {
  return (
    db
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE service_id = ?`)
      .get(serviceId)?.n ?? 0
  );
}

const CHILD_TABLES = ["service_jobs", "service_backups", "service_logs", "terminal_sessions"];

describe("0029 — directive", () => {
  test("parse directive ได้ และ foreign_keys กลับมาเปิดหลัง migrate", () => {
    const m = all.find((x) => x.version === "0029");
    expect(m?.disableForeignKeys).toBe(true);
    expect(all.filter((x) => x.disableForeignKeys).map((x) => x.version)).toEqual(["0029"]);

    const db = openDatabase({ path: ":memory:" });
    migrateUp(db, all);
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(
      1,
    );
  });
});

describe("0029 — services.type", () => {
  test("ชนิดใหม่ insert ได้ ชนิดที่ไม่รู้จักยังถูกปฏิเสธ", () => {
    const db = openDatabase({ path: ":memory:" });
    migrateUp(db, all);
    for (const type of ["pgvector", "minio", "clamav", "postgres"]) {
      expect(() => insertService(db, `svc-${type}`, type)).not.toThrow();
    }
    expect(() => insertService(db, "svc-bad", "oracle")).toThrow();
  });

  test("index ถูกสร้างใหม่ครบ", () => {
    const db = openDatabase({ path: ":memory:" });
    migrateUp(db, all);
    const names = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'services'",
      )
      .all()
      .map((r) => r.name);
    expect(names).toContain("idx_services_status");
    expect(names).toContain("idx_services_type");
  });
});

describe("0029 — ข้อมูลลูกต้องไม่หาย", () => {
  test("backup/log/job/terminal ของ service เดิมอยู่ครบหลัง migrate up", () => {
    const db = openDatabase({ path: ":memory:" });
    migrateUp(db, before0029);
    insertService(db, "svc-pg", "postgres");
    insertChildren(db, "svc-pg");

    migrateUp(db, all);

    for (const table of CHILD_TABLES) expect(count(db, table, "svc-pg")).toBe(1);
    const row = db
      .query<{ backup_enabled: number; backup_retention_count: number }, []>(
        "SELECT backup_enabled, backup_retention_count FROM services WHERE id = 'svc-pg'",
      )
      .get();
    expect(row).toEqual({ backup_enabled: 1, backup_retention_count: 5 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

    // FK ยังผูกกับตาราง services ตัวใหม่: ลบ service แล้วแถวลูก cascade ตามปกติ
    db.query("DELETE FROM services WHERE id = 'svc-pg'").run();
    for (const table of CHILD_TABLES) expect(count(db, table, "svc-pg")).toBe(0);
  });

  test("rollback ทิ้งเฉพาะชนิดใหม่ ของเดิมและแถวลูกอยู่ครบ ไม่เหลือ orphan", () => {
    const db = openDatabase({ path: ":memory:" });
    migrateUp(db, all);
    insertService(db, "svc-pg", "postgres");
    insertChildren(db, "svc-pg");
    insertService(db, "svc-minio", "minio");
    insertChildren(db, "svc-minio");

    migrateDown(db, all, 1);

    for (const table of CHILD_TABLES) {
      expect(count(db, table, "svc-pg")).toBe(1);
      expect(count(db, table, "svc-minio")).toBe(0);
    }
    expect(db.query("SELECT id FROM services").all()).toEqual([{ id: "svc-pg" }]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => insertService(db, "svc-x", "minio")).toThrow();
  });
});

describe("runner — disable-foreign-keys", () => {
  test("migration ที่ทิ้ง foreign key violation ไว้ถูก rollback และ foreign_keys กลับมาเปิด", () => {
    const db = openDatabase({ path: ":memory:" });
    const migrations = [
      parseMigrationFile(
        "0001_a.sql",
        `-- migrate:up
CREATE TABLE p (id TEXT PRIMARY KEY);
CREATE TABLE c (id TEXT PRIMARY KEY, p_id TEXT NOT NULL REFERENCES p(id));
-- migrate:down
DROP TABLE c;
DROP TABLE p;`,
      ),
      parseMigrationFile(
        "0002_b.sql",
        `-- migrate:disable-foreign-keys
-- migrate:up
INSERT INTO c (id, p_id) VALUES ('c1', 'missing');
-- migrate:down
DELETE FROM c;`,
      ),
    ];

    expect(() => migrateUp(db, migrations)).toThrow(/foreign key violation/);
    expect(db.query("SELECT COUNT(*) AS n FROM c").get()).toEqual({ n: 0 });
    expect(
      db.query<{ version: string }, []>("SELECT version FROM schema_migrations").all(),
    ).toEqual([{ version: "0001" }]);
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(
      1,
    );
  });
});
