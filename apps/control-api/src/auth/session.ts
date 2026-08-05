import type { Database } from "bun:sqlite";

/**
 * Session tokens (docs/phase-01)
 *
 * Token จริงอยู่ในคุกกี้ของ client เท่านั้น — DB เก็บเฉพาะ SHA-256 hash
 * ดังนั้น database ที่หลุดออกไปไม่สามารถนำไปสวมสิทธิ์ session ที่ยังไม่หมดอายุได้
 */

export const SESSION_COOKIE = "zx_session";
export const CSRF_COOKIE = "zx_csrf";
export const CSRF_HEADER = "x-csrf-token";

/** อายุ session — ต่ออายุอัตโนมัติไม่ได้ใน MVP, หมดอายุแล้วต้อง login ใหม่ */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionRow {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_seen_at: number;
}

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/** อ่านค่าคุกกี้เป็น string — Elysia ให้ type เป็น unknown เพราะรองรับ typed cookie */
export function cookieValue(cookie: { value?: unknown } | undefined): string | undefined {
  const value = cookie?.value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export interface CreatedSession {
  /** ค่าที่ส่งให้ client ผ่านคุกกี้ — ไม่เคยถูกเก็บลง DB */
  token: string;
  csrfToken: string;
  expiresAt: number;
}

export function createSession(db: Database, userId: string, now = Date.now()): CreatedSession {
  const token = randomToken();
  const expiresAt = now + SESSION_TTL_MS;
  db.query(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at, last_seen_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run(hashToken(token), userId, now, expiresAt, now);
  return { token, csrfToken: randomToken(), expiresAt };
}

export interface ActiveSession {
  sessionId: string;
  userId: string;
  expiresAt: number;
}

/** คืน session ที่ยังใช้ได้เท่านั้น — หมดอายุหรือถูก revoke ให้ถือว่าไม่มี */
export function findActiveSession(
  db: Database,
  token: string,
  now = Date.now(),
): ActiveSession | null {
  const row = db
    .query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?")
    .get(hashToken(token));
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at <= now) return null;
  return { sessionId: row.id, userId: row.user_id, expiresAt: row.expires_at };
}

export function touchSession(db: Database, sessionId: string, now = Date.now()): void {
  db.query("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(now, sessionId);
}

export function revokeSession(db: Database, token: string, now = Date.now()): void {
  db.query("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(
    now,
    hashToken(token),
  );
}

/** ใช้เมื่อเปลี่ยน password หรือสงสัยว่า session รั่ว */
export function revokeAllSessions(db: Database, userId: string, now = Date.now()): number {
  return db
    .query("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
    .run(now, userId).changes;
}

/** ลบ session ที่หมดอายุนานแล้ว — เรียกเป็นระยะเพื่อไม่ให้ตารางโต */
export function purgeExpiredSessions(db: Database, now = Date.now()): number {
  return db.query("DELETE FROM sessions WHERE expires_at <= ?").run(now).changes;
}

/**
 * CSRF: double-submit cookie
 * คุกกี้ CSRF อ่านได้จาก JS (ไม่ใช่ httpOnly) เพื่อให้ frontend ส่งกลับมาใน header
 * เว็บไซต์อื่นอ่านคุกกี้ของเราไม่ได้ จึงปลอมค่าใน header ให้ตรงกันไม่ได้
 */
export function csrfTokensMatch(cookieValue: string | undefined, headerValue: string | null) {
  if (!cookieValue || !headerValue) return false;
  if (cookieValue.length !== headerValue.length) return false;
  return timingSafeEqualStrings(cookieValue, headerValue);
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  return diff === 0;
}
