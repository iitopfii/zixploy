import { Database } from "bun:sqlite";

export interface OpenOptions {
  /** ":memory:" สำหรับ tests */
  path: string;
  readonly?: boolean;
}

/**
 * เปิด SQLite ตาม convention ของระบบ: WAL, foreign keys, busy timeout
 * ทุก connection ในระบบต้องผ่านฟังก์ชันนี้ — ห้ามเปิด Database ตรง ๆ
 */
export function openDatabase(options: OpenOptions): Database {
  const db = new Database(options.path, {
    readonly: options.readonly ?? false,
    create: !options.readonly,
    strict: true,
  });
  // foreign keys และ busy timeout เป็น per-connection setting ตั้งได้ทั้งสองโหมด
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  // journal_mode/synchronous เขียนลงไฟล์ — ตั้งได้เฉพาะ connection ที่เขียนได้
  if (!options.readonly) {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  return db;
}
