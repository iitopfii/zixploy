import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Migration runner — ไฟล์ SQL ใน migrations/ ชื่อ NNNN_description.sql
 * แต่ละไฟล์มี section `-- migrate:up` และ `-- migrate:down` (ดู docs/database-schema.md)
 */

export interface Migration {
  version: string; // "0001"
  name: string; // "0001_init"
  up: string;
  down: string;
  /**
   * ไฟล์มี `-- migrate:disable-foreign-keys` — ปิด foreign_keys ระหว่างรัน (ทั้ง up และ down)
   *
   * จำเป็นเมื่อต้อง rebuild ตาราง parent ที่ตารางอื่นอ้างด้วย ON DELETE CASCADE: SQLite แก้ CHECK
   * ตรง ๆ ไม่ได้ และ DROP TABLE ตอน foreign_keys เปิดอยู่ = DELETE ทุกแถว → cascade ลบตารางลูกหมด
   * (ขั้นตอน 12 ข้อใน https://www.sqlite.org/lang_altertable.html#otheralter) PRAGMA นี้ตั้งใน
   * transaction ไม่ได้ runner จึงตั้งให้ก่อนเปิด transaction แล้วรัน foreign_key_check ก่อน commit
   */
  disableForeignKeys: boolean;
}

const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
const DISABLE_FK_DIRECTIVE = "-- migrate:disable-foreign-keys";

export function parseMigrationFile(name: string, content: string): Migration {
  const match = FILE_RE.exec(name);
  if (!match?.[1]) {
    throw new Error(`migration filename must match NNNN_description.sql: ${name}`);
  }
  const upIndex = content.indexOf("-- migrate:up");
  const downIndex = content.indexOf("-- migrate:down");
  if (upIndex === -1 || downIndex === -1 || downIndex < upIndex) {
    throw new Error(`migration ${name} must contain "-- migrate:up" then "-- migrate:down"`);
  }
  const up = content.slice(upIndex + "-- migrate:up".length, downIndex).trim();
  const down = content.slice(downIndex + "-- migrate:down".length).trim();
  if (!up) throw new Error(`migration ${name} has empty up section`);
  return {
    version: match[1],
    name: name.replace(/\.sql$/, ""),
    up,
    down,
    disableForeignKeys: content.slice(0, upIndex).includes(DISABLE_FK_DIRECTIVE),
  };
}

/**
 * รัน fn ใน transaction — ถ้า migration ขอปิด foreign_keys จะปิดก่อนเปิด transaction
 * แล้วตรวจ foreign_key_check ภายใน transaction (เจอ = throw → rollback ทั้งไฟล์) และคืนค่าเดิมเสมอ
 */
function runMigrationStep(db: Database, migration: Migration, fn: () => void): void {
  if (!migration.disableForeignKeys) {
    db.transaction(fn)();
    return;
  }
  const previous = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    db.transaction(() => {
      fn();
      const violations = db.query("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new Error(
          `migration ${migration.name} left ${violations.length} foreign key violation(s): ${JSON.stringify(violations.slice(0, 5))}`,
        );
      }
    })();
  } finally {
    db.exec(`PRAGMA foreign_keys = ${previous?.foreign_keys ? "ON" : "OFF"};`);
  }
}

export function loadMigrations(dir: string): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const migrations = files.map((f) => parseMigrationFile(f, readFileSync(join(dir, f), "utf8")));
  const versions = new Set(migrations.map((m) => m.version));
  if (versions.size !== migrations.length) {
    throw new Error("duplicate migration versions found");
  }
  return migrations;
}

function ensureMigrationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
}

export function appliedVersions(db: Database): string[] {
  ensureMigrationTable(db);
  return db
    .query<{ version: string }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((r) => r.version);
}

/** รัน migration ที่ยังไม่ apply ทั้งหมด — แต่ละไฟล์ใน transaction เดียว */
export function migrateUp(db: Database, migrations: Migration[]): string[] {
  ensureMigrationTable(db);
  const applied = new Set(appliedVersions(db));
  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    runMigrationStep(db, migration, () => {
      db.exec(migration.up);
      db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        Date.now(),
      );
    });
    ran.push(migration.name);
  }
  return ran;
}

/**
 * Rollback ทีละ step (development เท่านั้น — production ใช้ forward-fix)
 */
export function migrateDown(db: Database, migrations: Migration[], steps = 1): string[] {
  ensureMigrationTable(db);
  const applied = appliedVersions(db);
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  const ran: string[] = [];
  for (const version of applied.reverse().slice(0, steps)) {
    const migration = byVersion.get(version);
    if (!migration) throw new Error(`applied migration ${version} not found on disk`);
    runMigrationStep(db, migration, () => {
      db.exec(migration.down);
      db.query("DELETE FROM schema_migrations WHERE version = ?").run(version);
    });
    ran.push(migration.name);
  }
  return ran;
}

/** API/worker เรียกตอน start — เวอร์ชันไม่ครบ = fail closed */
export function assertMigrated(db: Database, migrations: Migration[]): void {
  const applied = new Set(appliedVersions(db));
  const missing = migrations.filter((m) => !applied.has(m.version));
  if (missing.length > 0) {
    throw new Error(
      `database is missing ${missing.length} migration(s): ${missing.map((m) => m.name).join(", ")} — run migrations before starting`,
    );
  }
}
