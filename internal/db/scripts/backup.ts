/**
 * สร้าง backup ของ control plane ทั้งชุด — docs/phase-08-production.md "Backup automation"
 *
 *   bun run backup
 *
 * สำรอง 3 ส่วนแยก directory กัน (encryption key ต้องแยกช่องทางจาก DB เสมอ — docs/encryption.md):
 * 1. SQLite consistent snapshot        → ZIXPLOY_BACKUP_DB_DIR   (default backups/db)
 * 2. Master key file (ถ้าตั้ง ZIXPLOY_MASTER_KEY_FILE)   → ZIXPLOY_BACKUP_KEYS_DIR (default backups/keys)
 * 3. Traefik ACME storage (ถ้าตั้ง ZIXPLOY_ACME_FILE)     → ZIXPLOY_BACKUP_ACME_DIR (default backups/acme)
 *
 * GitHub App private key/webhook secret ไม่ต้อง backup แยก — เก็บเป็น ciphertext ใน DB อยู่แล้ว
 * (ดู docs/encryption.md "GitHub App credentials") ครอบคลุมด้วย backup DB ข้อ 1
 *
 * หลัง backup สำเร็จแต่ละส่วน จะลบไฟล์เก่าเกิน ZIXPLOY_BACKUP_RETENTION ชุด (default 14) ทิ้ง
 * exit code != 0 ถ้าส่วนใดที่ "ตั้งค่าไว้" backup ไม่สำเร็จ — ส่วนที่ไม่ได้ตั้งค่า (เช่นยังไม่มี ACME
 * เพราะ M6 ยังไม่ deploy) จะข้ามแบบ warning เท่านั้น
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  acmeBackupDir,
  backupDatabase,
  backupRetentionCount,
  backupSecretFile,
  databasePath,
  dbBackupDir,
  keysBackupDir,
  pruneOldBackups,
  verifyBackup,
} from "../src";
import { openDatabase } from "../src/connection";

let failed = false;

function step(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    failed = true;
    console.error(`[backup] ${label} ล้มเหลว: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 1. SQLite snapshot ------------------------------------------------------
const dbDir = dbBackupDir();
const retention = backupRetentionCount();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

step("SQLite snapshot", () => {
  const destination = join(dbDir, `zixploy-${stamp}.sqlite`);
  mkdirSync(dbDir, { recursive: true });
  const db = openDatabase({ path: databasePath(), readonly: true });
  try {
    backupDatabase(db, destination);
  } finally {
    db.close();
  }
  if (!verifyBackup(destination)) {
    throw new Error(`${destination} ไม่ผ่าน integrity check`);
  }
  const deleted = pruneOldBackups(dbDir, retention);
  console.log(`[backup] SQLite snapshot สำเร็จ: ${destination}`);
  if (deleted.length > 0) console.log(`[backup] ลบ backup เก่า ${deleted.length} ไฟล์ (DB)`);
});

// 2. Master key file (แยกช่องทางจาก DB เสมอ) -------------------------------
const masterKeyFile = process.env.ZIXPLOY_MASTER_KEY_FILE;
if (masterKeyFile) {
  step("Master key backup", () => {
    const dest = backupSecretFile(masterKeyFile, keysBackupDir(), "master-key", Date.now());
    const deleted = pruneOldBackups(keysBackupDir(), retention);
    console.log(`[backup] Master key backup สำเร็จ: ${dest}`);
    if (deleted.length > 0) console.log(`[backup] ลบ backup เก่า ${deleted.length} ไฟล์ (keys)`);
  });
} else {
  console.warn("[backup] ข้าม master key — ไม่ได้ตั้ง ZIXPLOY_MASTER_KEY_FILE");
}

// 3. Traefik ACME storage --------------------------------------------------
const acmeFile = process.env.ZIXPLOY_ACME_FILE;
if (acmeFile) {
  step("ACME storage backup", () => {
    const dest = backupSecretFile(acmeFile, acmeBackupDir(), "acme", Date.now());
    const deleted = pruneOldBackups(acmeBackupDir(), retention);
    console.log(`[backup] ACME storage backup สำเร็จ: ${dest}`);
    if (deleted.length > 0) console.log(`[backup] ลบ backup เก่า ${deleted.length} ไฟล์ (acme)`);
  });
} else {
  console.warn("[backup] ข้าม ACME storage — ไม่ได้ตั้ง ZIXPLOY_ACME_FILE");
}

if (failed) {
  console.error("[backup] เสร็จพร้อม error — ดูรายละเอียดด้านบน");
  process.exit(1);
}

console.log("[backup] เสร็จสมบูรณ์ทุกส่วนที่ตั้งค่าไว้");
