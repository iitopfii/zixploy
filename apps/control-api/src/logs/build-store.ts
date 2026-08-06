/**
 * Build log read operations — control-api อ่านจาก SQLite ที่ worker write ไว้
 *
 * Worker เป็น writer ฝ่ายเดียว; ฟังก์ชันทั้งหมดที่นี่เป็น read-only
 * ไม่มีการ join กับตาราง secrets/env ใด — log ถูก redact แล้วก่อน persist
 */

import type { Database } from "bun:sqlite";

export interface BuildLogRow {
  id: string;
  deployment_id: string;
  seq: number;
  stream: "stdout" | "stderr";
  line: string;
  created_at: number;
}

export interface BuildLogDto {
  id: string;
  deploymentId: string;
  seq: number;
  stream: "stdout" | "stderr";
  line: string;
  createdAt: number;
}

function toDto(row: BuildLogRow): BuildLogDto {
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    seq: row.seq,
    stream: row.stream,
    line: row.line,
    createdAt: row.created_at,
  };
}

/** คืน log rows ที่มี seq > afterSeq เรียง ASC — สำหรับ pagination และ SSE polling */
export function listBuildLogs(
  db: Database,
  deploymentId: string,
  opts: { afterSeq?: number; limit?: number } = {},
): BuildLogDto[] {
  const afterSeq = opts.afterSeq ?? 0;
  const limit = Math.min(opts.limit ?? 500, 500); // cap at 500 per request

  return db
    .query<BuildLogRow, [string, number, number]>(
      `SELECT id, deployment_id, seq, stream, line, created_at
       FROM build_logs
       WHERE deployment_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
    )
    .all(deploymentId, afterSeq, limit)
    .map(toDto);
}

/** คืน seq สูงสุดที่มีอยู่ใน deployment (ใช้โดย SSE ก่อนเริ่ม stream) */
export function getMaxSeq(db: Database, deploymentId: string): number {
  const row = db
    .query<{ max_seq: number | null }, [string]>(
      "SELECT MAX(seq) as max_seq FROM build_logs WHERE deployment_id = ?",
    )
    .get(deploymentId);
  return row?.max_seq ?? 0;
}

/** คืน seq ล่าสุดที่มีอยู่ (ใช้ตรวจว่ายังมี log ใหม่มาไหมใน SSE polling) */
export function hasNewLogs(db: Database, deploymentId: string, afterSeq: number): boolean {
  const row = db
    .query<{ cnt: number }, [string, number]>(
      "SELECT COUNT(*) as cnt FROM build_logs WHERE deployment_id = ? AND seq > ?",
    )
    .get(deploymentId, afterSeq);
  return (row?.cnt ?? 0) > 0;
}
