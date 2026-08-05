import { join } from "node:path";

/** โฟลเดอร์ migrations ที่ root ของ repo */
export function migrationsDir(): string {
  return join(import.meta.dir, "..", "..", "..", "migrations");
}

/** ตำแหน่ง database file — override ได้ด้วย ZIXPLOY_DB_PATH */
export function databasePath(): string {
  return process.env.ZIXPLOY_DB_PATH ?? join(process.cwd(), "data", "zixploy.sqlite");
}
