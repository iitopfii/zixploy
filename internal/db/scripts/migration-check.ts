/**
 * CI check: migrations ทั้งหมดรันจากฐานข้อมูลว่างได้ + rollback ครบ + รันซ้ำได้ (up-down-up)
 * ใช้ in-memory database — ไม่แตะข้อมูลจริง
 */
import { loadMigrations, migrateDown, migrateUp, openDatabase } from "../src/index";
import { migrationsDir } from "../src/paths";

const migrations = loadMigrations(migrationsDir());
if (migrations.length === 0) {
  console.error("no migrations found");
  process.exit(1);
}

const db = openDatabase({ path: ":memory:" });

const up1 = migrateUp(db, migrations);
console.log(`up:   applied ${up1.length}/${migrations.length}`);
if (up1.length !== migrations.length) {
  console.error("expected all migrations to apply on empty database");
  process.exit(1);
}

const down = migrateDown(db, migrations, migrations.length);
console.log(`down: rolled back ${down.length}/${migrations.length}`);
if (down.length !== migrations.length) {
  console.error("expected all migrations to roll back");
  process.exit(1);
}

const up2 = migrateUp(db, migrations);
if (up2.length !== migrations.length) {
  console.error("expected all migrations to re-apply after rollback");
  process.exit(1);
}

console.log("migration check passed");
