/**
 * สร้าง backup ของ control-plane database
 *
 *   bun run backup [destination]
 *
 * ค่าเริ่มต้นเขียนไปที่ backups/zixploy-<timestamp>.sqlite
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { backupDatabase, verifyBackup } from "../src/backup";
import { openDatabase } from "../src/connection";
import { databasePath } from "../src/paths";

const source = databasePath();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = process.argv[2] ?? join(process.cwd(), "backups", `zixploy-${stamp}.sqlite`);

mkdirSync(dirname(destination), { recursive: true });

const db = openDatabase({ path: source, readonly: true });
backupDatabase(db, destination);
db.close();

if (!verifyBackup(destination)) {
  console.error(`backup ที่ ${destination} ไม่ผ่าน integrity check`);
  process.exit(1);
}

console.log(`backup สำเร็จ: ${destination}`);
console.log("อย่าลืมสำรอง encryption master key แยกช่องทาง (ดู docs/encryption.md)");
