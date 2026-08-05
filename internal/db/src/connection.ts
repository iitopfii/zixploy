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
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  return db;
}
