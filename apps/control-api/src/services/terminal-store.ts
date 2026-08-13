/**
 * Interactive terminal sessions — Phase 17
 *
 * ADR-0002: control-api ไม่แตะ Docker เลย — ไม่มีการ exec เข้า container ที่นี่ โมดูลนี้ทำแค่
 * เขียน/อ่านแถวใน terminal_sessions ซึ่งเป็น "กระดานงาน" ให้ worker (ที่ poll เป็นระยะ ไม่มี
 * server ของตัวเอง) รู้ว่ามี session ไหนรอให้ต่อ WebSocket กลับมาบ้าง
 *
 * control-api สร้างแถว status='pending' เท่านั้น (createPendingSession) — worker เป็นคน
 * claim/update เป็น 'active' เองผ่าน DB โดยตรง (ไม่ผ่าน HTTP, ตาม ADR-0002) เราจึงไม่มีฟังก์ชัน
 * claim ในไฟล์นี้เลยโดยตั้งใจ ดู apps/control-api/src/routes/terminal.ts สำหรับ relay จริง
 * (WebSocket byte-for-byte ระหว่าง browser <-> worker ที่ control-api ถือสองฝั่งไว้)
 */

import type { Database } from "bun:sqlite";
import { AppError, ulid } from "@zixploy/shared";
import { requireService } from "./store";

export interface TerminalSessionRow {
  id: string;
  service_id: string;
  status: string;
  failure_message: string | null;
  created_at: number;
  claimed_at: number | null;
  closed_at: number | null;
}

const SELECT_ALL = `
  id, service_id, status, failure_message, created_at, claimed_at, closed_at
`;

/**
 * สร้างแถว pending ใหม่ — ตรวจก่อนว่า service มีอยู่จริง (โยน SERVICE_NOT_FOUND ถ้าไม่)
 * เพื่อไม่ให้มีแถว terminal_sessions กำพร้าอ้างถึง service ที่ไม่มีอยู่
 */
export function createPendingSession(db: Database, serviceId: string): { id: string } {
  requireService(db, serviceId);

  const id = ulid();
  db.query(
    "INSERT INTO terminal_sessions (id, service_id, status, created_at) VALUES (?, ?, 'pending', ?)",
  ).run(id, serviceId, Date.now());
  return { id };
}

export function requireSession(db: Database, sessionId: string): TerminalSessionRow {
  const row = db
    .query<TerminalSessionRow, [string]>(`SELECT ${SELECT_ALL} FROM terminal_sessions WHERE id = ?`)
    .get(sessionId);
  if (!row) throw new AppError("TERMINAL_SESSION_NOT_FOUND", "ไม่พบ terminal session นี้");
  return row;
}

/**
 * ปิด session — status='failed' ถ้าให้ failureMessage มา ไม่งั้น 'closed' (ปิดปกติ เช่น
 * ผู้ใช้ปิดแท็บ, worker ปิดการเชื่อมต่อ, หรือ idle timeout)
 *
 * ไม่เช็คว่าแถวมีอยู่จริงก่อน UPDATE โดยตั้งใจ — เรียกจาก relay cleanup path ที่อาจถูกเรียกซ้ำ
 * (เช่น ปิดทั้งสอง callback พร้อมกัน) การ UPDATE 0 แถวไม่ใช่ error ในบริบทนี้
 */
export function markSessionClosed(
  db: Database,
  sessionId: string,
  opts: { failureMessage?: string } = {},
): void {
  db.query(
    "UPDATE terminal_sessions SET status = ?, failure_message = ?, closed_at = ? WHERE id = ?",
  ).run(
    opts.failureMessage ? "failed" : "closed",
    opts.failureMessage ?? null,
    Date.now(),
    sessionId,
  );
}
