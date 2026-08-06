import { join } from "node:path";

/** โฟลเดอร์ migrations ที่ root ของ repo */
export function migrationsDir(): string {
  return join(import.meta.dir, "..", "..", "..", "migrations");
}

/** ตำแหน่ง database file — override ได้ด้วย ZIXPLOY_DB_PATH */
export function databasePath(): string {
  return process.env.ZIXPLOY_DB_PATH ?? join(process.cwd(), "data", "zixploy.sqlite");
}

/**
 * Backup destination directories — docs/phase-08-production.md "Backup automation"
 *
 * แยก directory ต่อประเภทไฟล์โดยตั้งใจ (DB / master key / ACME storage) เพื่อให้ operator
 * ชี้แต่ละอันไปคนละ storage/mount จริงได้ (encryption key ต้อง backup แยกช่องทางจาก DB เสมอ)
 */
export function dbBackupDir(): string {
  return process.env.ZIXPLOY_BACKUP_DB_DIR ?? join(process.cwd(), "backups", "db");
}

export function keysBackupDir(): string {
  return process.env.ZIXPLOY_BACKUP_KEYS_DIR ?? join(process.cwd(), "backups", "keys");
}

export function acmeBackupDir(): string {
  return process.env.ZIXPLOY_BACKUP_ACME_DIR ?? join(process.cwd(), "backups", "acme");
}

/** จำนวน backup ล่าสุดที่เก็บไว้ต่อ directory — เก่ากว่านี้ถูกลบทิ้งหลัง backup สำเร็จ */
export function backupRetentionCount(): number {
  const raw = Number(process.env.ZIXPLOY_BACKUP_RETENTION ?? 14);
  return Number.isInteger(raw) && raw > 0 ? raw : 14;
}
