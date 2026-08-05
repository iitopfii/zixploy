/**
 * สร้าง admin คนแรก (docs/phase-01 — single admin bootstrap)
 *
 *   ZIXPLOY_ADMIN_USERNAME=admin ZIXPLOY_ADMIN_PASSWORD=... bun run bootstrap:admin
 *
 * รันซ้ำได้อย่างปลอดภัย: ถ้ามี admin อยู่แล้วจะไม่แก้ไขอะไรและออกด้วย exit code 0
 * เปลี่ยน password ใช้ `--reset` ซึ่งจะ revoke ทุก session ของ user นั้นด้วย
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { databasePath, loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { hashPassword, PASSWORD_MIN_LENGTH } from "../auth/password";
import { revokeAllSessions } from "../auth/session";

const username = process.env.ZIXPLOY_ADMIN_USERNAME;
const password = process.env.ZIXPLOY_ADMIN_PASSWORD;
const reset = process.argv.includes("--reset");

if (!username || !password) {
  console.error("ต้องกำหนด ZIXPLOY_ADMIN_USERNAME และ ZIXPLOY_ADMIN_PASSWORD ก่อนรันคำสั่งนี้");
  process.exit(1);
}

if (password.length < PASSWORD_MIN_LENGTH) {
  console.error(`password ต้องยาวอย่างน้อย ${PASSWORD_MIN_LENGTH} ตัวอักษร`);
  process.exit(1);
}

const dbPath = databasePath();
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
const db = openDatabase({ path: dbPath });
migrateUp(db, loadMigrations(migrationsDir()));

const existing = db
  .query<{ id: string }, [string]>("SELECT id FROM users WHERE username = ?")
  .get(username);

const now = Date.now();

if (existing && !reset) {
  console.log(`admin "${username}" มีอยู่แล้ว — ไม่มีการเปลี่ยนแปลง (ใช้ --reset เพื่อตั้ง password ใหม่)`);
  process.exit(0);
}

const passwordHash = await hashPassword(password);

if (existing) {
  db.transaction(() => {
    db.query("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
      passwordHash,
      now,
      existing.id,
    );
    // password เปลี่ยน = session เดิมต้องใช้ไม่ได้อีก
    revokeAllSessions(db, existing.id, now);
  })();
  console.log(`ตั้ง password ใหม่ให้ "${username}" แล้ว และ revoke ทุก session เดิม`);
} else {
  const anyUser = db.query<{ n: number }, []>("SELECT count(*) as n FROM users").get()?.n ?? 0;
  if (anyUser > 0) {
    console.error("ระบบรองรับ admin เดียวใน MVP — มี user อยู่แล้วในฐานข้อมูล");
    process.exit(1);
  }
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(ulid(), username, passwordHash, now, now);
  console.log(`สร้าง admin "${username}" เรียบร้อย`);
}
