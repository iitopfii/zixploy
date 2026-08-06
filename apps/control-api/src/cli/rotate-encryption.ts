/**
 * Key rotation CLI สำหรับ environment_variables — docs/phase-04-environment.md M5
 *
 * Re-encrypt ทุกแถวใน environment_variables ที่ยังไม่ได้ใช้ active key ปัจจุบัน
 *
 * ก่อนรัน:
 *   1. อัปเดต ZIXPLOY_MASTER_KEY_FILE ให้มีทั้ง old keys และ new key
 *      และตั้ง "active" เป็น key id ใหม่
 *   2. ตรวจสอบว่ามี backup ล่าสุดแล้ว (ดู docs/runbooks/rotate-encryption-key.md)
 *
 * การใช้งาน:
 *   ZIXPLOY_MASTER_KEY_FILE=./keys.json bun run rotate:encryption
 *   ZIXPLOY_MASTER_KEY_FILE=./keys.json bun run rotate:encryption --dry-run  (อ่านอย่างเดียว, ไม่เขียน)
 *
 * Exit codes:
 *   0 — สำเร็จ (rotate หรือ skip ทั้งหมด, ไม่มี failed)
 *   1 — error ขั้นต้น (ไม่มี key file, DB error) หรือมีแถว failed > 0
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { databasePath, loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { loadMasterKeys } from "../crypto/master-key";
import { rotateEnvVarKeys } from "../env/rotation";

const dryRun = process.argv.includes("--dry-run");

// Load master keys
let masterKeys: Awaited<ReturnType<typeof loadMasterKeys>>;
try {
  masterKeys = await loadMasterKeys();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[rotate-encryption] โหลด master key ไม่ได้: ${msg}`);
  process.exit(1);
}

if (!masterKeys) {
  console.error(
    "[rotate-encryption] ต้องกำหนด ZIXPLOY_MASTER_KEY_FILE ก่อนรัน key rotation\n" +
      "  ดูรายละเอียด: docs/runbooks/rotate-encryption-key.md",
  );
  process.exit(1);
}

// Open DB
const dbPath = databasePath();
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
const db = openDatabase({ path: dbPath });
migrateUp(db, loadMigrations(migrationsDir()));

console.log(`[rotate-encryption] active key id = ${masterKeys.active}`);
console.log(`[rotate-encryption] DB = ${dbPath}`);

if (dryRun) {
  console.log("[rotate-encryption] DRY RUN — ไม่มีการเขียนลง DB");

  // อ่านแถวและนับว่ากี่แถวต้อง rotate
  const rows = db
    .query<{ id: string; value_ciphertext: Buffer }, []>(
      "SELECT id, value_ciphertext FROM environment_variables",
    )
    .all();

  let needsRotation = 0;
  let alreadyCurrent = 0;
  for (const row of rows) {
    const keyId = new Uint8Array(row.value_ciphertext)[1];
    if (keyId === masterKeys.active) alreadyCurrent++;
    else needsRotation++;
  }

  console.log(
    `[rotate-encryption] dry-run summary: total=${rows.length}, needs-rotation=${needsRotation}, already-current=${alreadyCurrent}`,
  );
  process.exit(0);
}

// Run rotation
let result: Awaited<ReturnType<typeof rotateEnvVarKeys>>;
try {
  result = await rotateEnvVarKeys(db, masterKeys, {
    batchSize: 50,
    onProgress: (msg) => console.log(`[rotate-encryption] ${msg}`),
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[rotate-encryption] rotation ล้มเหลว: ${msg}`);
  process.exit(1);
}

if (result.failed > 0) {
  console.error(
    `[rotate-encryption] มี ${result.failed} แถวที่ rotate ไม่สำเร็จ — ตรวจสอบ key file และลองใหม่`,
  );
  process.exit(1);
}

console.log(
  `[rotate-encryption] สำเร็จ: rotated=${result.rotated} skipped=${result.skipped} total=${result.total}`,
);
