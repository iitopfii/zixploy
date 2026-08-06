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
