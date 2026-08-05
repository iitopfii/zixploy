import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/connection";
import {
  appliedVersions,
  assertMigrated,
  loadMigrations,
  migrateDown,
  migrateUp,
  parseMigrationFile,
} from "../src/migrate";
import { migrationsDir } from "../src/paths";

const sample = `-- migrate:up
CREATE TABLE t1 (id TEXT PRIMARY KEY);

-- migrate:down
DROP TABLE t1;
`;

describe("parseMigrationFile", () => {
  test("แยก up/down sections ถูกต้อง", () => {
    const m = parseMigrationFile("0001_init.sql", sample);
    expect(m.version).toBe("0001");
    expect(m.up).toContain("CREATE TABLE t1");
    expect(m.down).toContain("DROP TABLE t1");
  });

  test("ปฏิเสธชื่อไฟล์ผิด format และไฟล์ที่ไม่มี markers", () => {
    expect(() => parseMigrationFile("init.sql", sample)).toThrow();
    expect(() => parseMigrationFile("0001_init.sql", "CREATE TABLE x (id TEXT);")).toThrow();
  });
});

describe("migration runner", () => {
  const migrations = [
    parseMigrationFile("0001_a.sql", sample),
    parseMigrationFile(
      "0002_b.sql",
      `-- migrate:up
CREATE TABLE t2 (id TEXT PRIMARY KEY, t1_id TEXT REFERENCES t1(id));

-- migrate:down
DROP TABLE t2;
`,
    ),
  ];

  test("up จากฐานว่าง, idempotent, down กลับครบ", () => {
    const db = openDatabase({ path: ":memory:" });

    expect(migrateUp(db, migrations)).toEqual(["0001_a", "0002_b"]);
    expect(appliedVersions(db)).toEqual(["0001", "0002"]);

    // รันซ้ำไม่ apply ซ้ำ
    expect(migrateUp(db, migrations)).toEqual([]);

    // rollback ทีละ step ตามลำดับย้อนกลับ
    expect(migrateDown(db, migrations, 1)).toEqual(["0002_b"]);
    expect(appliedVersions(db)).toEqual(["0001"]);
    expect(migrateDown(db, migrations, 1)).toEqual(["0001_a"]);
    expect(appliedVersions(db)).toEqual([]);
  });

  test("assertMigrated fail closed เมื่อ migration ไม่ครบ", () => {
    const db = openDatabase({ path: ":memory:" });
    expect(() => assertMigrated(db, migrations)).toThrow(/missing 2 migration/);
    migrateUp(db, migrations);
    expect(() => assertMigrated(db, migrations)).not.toThrow();
  });

  test("migration fail = rollback ทั้งไฟล์ (transaction)", () => {
    const db = openDatabase({ path: ":memory:" });
    const bad = parseMigrationFile(
      "0001_bad.sql",
      `-- migrate:up
CREATE TABLE good (id TEXT PRIMARY KEY);
THIS IS NOT SQL;

-- migrate:down
DROP TABLE good;
`,
    );
    expect(() => migrateUp(db, [bad])).toThrow();
    // ตารางแรกในไฟล์ต้องไม่ค้างอยู่ และ version ต้องไม่ถูกบันทึก
    expect(appliedVersions(db)).toEqual([]);
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((t) => t.name);
    expect(tables).not.toContain("good");
  });
});

describe("real migrations directory", () => {
  test("ทุกไฟล์ parse ได้และ up-down-up จากฐานว่างผ่าน", () => {
    const migrations = loadMigrations(migrationsDir());
    expect(migrations.length).toBeGreaterThan(0);
    const db = openDatabase({ path: ":memory:" });
    expect(migrateUp(db, migrations).length).toBe(migrations.length);
    expect(migrateDown(db, migrations, migrations.length).length).toBe(migrations.length);
    expect(migrateUp(db, migrations).length).toBe(migrations.length);
  });
});

describe("connection pragmas", () => {
  test("foreign keys และ busy timeout เปิดใช้งาน", () => {
    const db = openDatabase({ path: ":memory:" });
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(
      1,
    );
    expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
  });
});
