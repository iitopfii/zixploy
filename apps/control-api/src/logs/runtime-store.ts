/**
 * Runtime log read operations — control-api อ่านจาก ring buffer ที่ worker เขียน
 *
 * Worker รัน `docker logs` ทุก LOG_SETTINGS.runtimePollMs และ INSERT ที่นี่
 * control-api อ่านเท่านั้น — ไม่มี Docker socket access (architecture.test.ts)
 */

import type { Database } from "bun:sqlite";

export interface RuntimeLogRow {
  id: string;
  project_id: string;
  container_id: string;
  seq: number;
  stream: "stdout" | "stderr";
  line: string;
  logged_at: number;
  created_at: number;
}

export interface RuntimeLogDto {
  id: string;
  projectId: string;
  containerId: string;
  seq: number;
  stream: "stdout" | "stderr";
  line: string;
  loggedAt: number;
  createdAt: number;
}

function toDto(row: RuntimeLogRow): RuntimeLogDto {
  return {
    id: row.id,
    projectId: row.project_id,
    containerId: row.container_id,
    seq: row.seq,
    stream: row.stream,
    line: row.line,
    loggedAt: row.logged_at,
    createdAt: row.created_at,
  };
}

/** คืน runtime log rows ที่มี seq > afterSeq เรียง ASC (สำหรับ pagination + SSE polling) */
/**
 * N บรรทัด **ล่าสุด** — ใช้ตอนเปิดหน้า log ครั้งแรก
 *
 * ต่างจาก listRuntimeLogs() ที่เดินหน้าจาก cursor: ถ้าเปิดหน้าแล้วเรียก listRuntimeLogs
 * โดยไม่มี cursor จะได้บรรทัด **เก่าสุด** ของ ring buffer (ORDER BY seq ASC จาก 0)
 * ซึ่งตรงข้ามกับที่คนเปิดดู log ต้องการ แล้ว SSE ยังต้องไล่ replay ประวัติทั้งก้อนตามมาอีก
 *
 * คืนผลเรียงเก่า→ใหม่เหมือน listRuntimeLogs เพื่อให้ผู้เรียกต่อท้าย stream ได้ตรง ๆ
 */
export function tailRuntimeLogs(db: Database, projectId: string, limit = 200): RuntimeLogDto[] {
  const capped = Math.min(Math.max(limit, 1), 500);
  return db
    .query<RuntimeLogRow, [string, number]>(
      `SELECT id, project_id, container_id, seq, stream, line, logged_at, created_at
       FROM runtime_logs
       WHERE project_id = ?
       ORDER BY seq DESC
       LIMIT ?`,
    )
    .all(projectId, capped)
    .reverse()
    .map(toDto);
}

export function listRuntimeLogs(
  db: Database,
  projectId: string,
  opts: { afterSeq?: number; limit?: number } = {},
): RuntimeLogDto[] {
  const afterSeq = opts.afterSeq ?? 0;
  const limit = Math.min(opts.limit ?? 500, 500);

  return db
    .query<RuntimeLogRow, [string, number, number]>(
      `SELECT id, project_id, container_id, seq, stream, line, logged_at, created_at
       FROM runtime_logs
       WHERE project_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
    )
    .all(projectId, afterSeq, limit)
    .map(toDto);
}
