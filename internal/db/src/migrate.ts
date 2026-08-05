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
}

const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

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
  return { version: match[1], name: name.replace(/\.sql$/, ""), up, down };
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
    const run = db.transaction(() => {
      db.exec(migration.up);
      db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        Date.now(),
      );
    });
    run();
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
    const run = db.transaction(() => {
      db.exec(migration.down);
      db.query("DELETE FROM schema_migrations WHERE version = ?").run(version);
    });
    run();
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
