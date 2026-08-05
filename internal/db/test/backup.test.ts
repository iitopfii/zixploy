import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDatabase, verifyBackup } from "../src/backup";
import { openDatabase } from "../src/connection";
import { loadMigrations, migrateUp } from "../src/migrate";
import { migrationsDir } from "../src/paths";

const dirs: string[] = [];
const openConnections: { close: () => void }[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "zixploy-backup-"));
  dirs.push(dir);
  return dir;
}

/** เปิด DB และจำไว้เพื่อปิดใน afterEach — Windows ลบไฟล์ที่ยังเปิดอยู่ไม่ได้ */
function open(path: string, readonly = false) {
  const db = openDatabase(readonly ? { path, readonly: true } : { path });
  openConnections.push(db);
  return db;
}

afterEach(() => {
  // close() แบบไม่ throw — cached prepared statements ยังอยู่ ให้ Bun finalize ให้เอง
  for (const db of openConnections.splice(0)) db.close();
  // Windows ปล่อย file handle ช้ากว่าที่ close() คืนค่า — ลองซ้ำสั้น ๆ แล้วปล่อยให้ OS เก็บกวาด
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        Bun.sleepSync(20);
      }
    }
  }
});

describe("backupDatabase", () => {
  test("snapshot มีข้อมูลครบและ integrity ผ่าน", () => {
    const dir = tempDir();
    const source = join(dir, "source.sqlite");
    const dest = join(dir, "backup.sqlite");

    const db = open(source);
    migrateUp(db, loadMigrations(migrationsDir()));
    db.query(
      "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("01JZZZZZZZZZZZZZZZZZZZZZZZ", "admin", "hash", Date.now(), Date.now());

    backupDatabase(db, dest);
    expect(verifyBackup(dest)).toBe(true);

    const restored = open(dest, true);
    const user = restored.query<{ username: string }, []>("SELECT username FROM users").get();
    expect(user?.username).toBe("admin");
    // schema version ต้องติดไปกับ backup ด้วย
    expect(
      restored.query<{ n: number }, []>("SELECT count(*) as n FROM schema_migrations").get()?.n,
    ).toBeGreaterThan(0);
  });

  test("เขียนทับ backup เดิมไม่ได้", () => {
    const dir = tempDir();
    const db = open(join(dir, "source.sqlite"));
    migrateUp(db, loadMigrations(migrationsDir()));
    const dest = join(dir, "backup.sqlite");

    backupDatabase(db, dest);
    expect(() => backupDatabase(db, dest)).toThrow(/already exists/);
  });

  test("ข้อมูลที่เขียนหลัง backup ไม่อยู่ใน snapshot (snapshot คงที่)", () => {
    const dir = tempDir();
    const db = open(join(dir, "source.sqlite"));
    migrateUp(db, loadMigrations(migrationsDir()));
    const dest = join(dir, "backup.sqlite");

    backupDatabase(db, dest);
    db.query(
      "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("01JZZZZZZZZZZZZZZZZZZZZZZZ", "later", "hash", Date.now(), Date.now());

    const restored = open(dest, true);
    expect(restored.query<{ n: number }, []>("SELECT count(*) as n FROM users").get()?.n).toBe(0);
  });
});
