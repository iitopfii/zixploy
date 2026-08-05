import type { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { openDatabase } from "./connection";

/**
 * Consistent snapshot ของ SQLite (docs/phase-01)
 *
 * ใช้ `VACUUM INTO` ซึ่งอ่านผ่าน transaction เดียว — ปลอดภัยขณะ WAL ยังถูกเขียนอยู่
 * ต่างจากการ copy ไฟล์ตรง ๆ ที่อาจได้ไฟล์ที่ไม่สอดคล้องกับ -wal
 *
 * หมายเหตุ backup ต้องเก็บคู่กับ encryption master key ที่อยู่ "คนละที่" — ดู docs/encryption.md
 */
export function backupDatabase(db: Database, destination: string): void {
  if (existsSync(destination)) {
    throw new Error(`backup destination already exists: ${destination}`);
  }
  db.query(`VACUUM INTO ?`).run(destination);
  restrictPermissions(destination);
}

/** จำกัดสิทธิ์ไฟล์ backup ให้เฉพาะเจ้าของ (no-op บน Windows) */
export function restrictPermissions(path: string): void {
  if (process.platform === "win32") return;
  chmodSync(path, 0o600);
}

/** ตรวจว่าไฟล์ backup เปิดได้และ integrity ผ่าน — ใช้หลัง backup ทุกครั้ง */
export function verifyBackup(path: string): boolean {
  const db = openDatabase({ path, readonly: true });
  try {
    const result = db
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .get()?.integrity_check;
    return result === "ok";
  } finally {
    db.close();
  }
}
