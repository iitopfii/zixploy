import type { Database } from "bun:sqlite";
import { ulid } from "@zixploy/shared";

/**
 * Login rate limiting (docs/phase-01)
 * บันทึกเฉพาะ username + client key + เวลา — ห้ามบันทึก password ที่ลองผิด
 */

export const LOGIN_LIMIT = {
  windowMs: 15 * 60 * 1000,
  maxAttempts: 10,
} as const;

export function recordFailedLogin(
  db: Database,
  username: string,
  clientKey: string,
  now = Date.now(),
): void {
  db.query(
    "INSERT INTO login_attempts (id, username, client_key, attempted_at) VALUES (?, ?, ?, ?)",
  ).run(ulid(), username, clientKey, now);
}

export function failedLoginCount(db: Database, clientKey: string, now = Date.now()): number {
  const row = db
    .query<{ n: number }, [string, number]>(
      "SELECT count(*) as n FROM login_attempts WHERE client_key = ? AND attempted_at > ?",
    )
    .get(clientKey, now - LOGIN_LIMIT.windowMs);
  return row?.n ?? 0;
}

export function isLoginRateLimited(db: Database, clientKey: string, now = Date.now()): boolean {
  return failedLoginCount(db, clientKey, now) >= LOGIN_LIMIT.maxAttempts;
}

/** ล้างประวัติของ client หลัง login สำเร็จ เพื่อไม่ให้ผู้ใช้ที่ถูกต้องโดนบล็อกภายหลัง */
export function clearFailedLogins(db: Database, clientKey: string): void {
  db.query("DELETE FROM login_attempts WHERE client_key = ?").run(clientKey);
}

export function purgeOldLoginAttempts(db: Database, now = Date.now()): number {
  return db
    .query("DELETE FROM login_attempts WHERE attempted_at <= ?")
    .run(now - LOGIN_LIMIT.windowMs).changes;
}
