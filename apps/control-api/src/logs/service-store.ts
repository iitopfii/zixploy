/**
 * Service log read operations — control-api อ่านจาก ring buffer ที่ worker เขียน
 *
 * Worker รัน `docker logs` ทุก LOG_SETTINGS.runtimePollMs แล้ว INSERT ลง service_logs
 * (apps/deploy-worker/src/logs/service-poller.ts) — control-api อ่านอย่างเดียว ไม่มี Docker
 * socket access (architecture.test.ts บังคับ)
 *
 * โครงเหมือน runtime-store.ts ของ project ทุกอย่าง ต่างที่คีย์เป็น service_id
 */

import type { Database } from "bun:sqlite";

export interface ServiceLogRow {
  id: string;
  service_id: string;
  container_id: string;
  seq: number;
  stream: "stdout" | "stderr";
  line: string;
  logged_at: number;
  created_at: number;
}

export interface ServiceLogDto {
  id: string;
  serviceId: string;
  containerId: string;
  seq: number;
  stream: "stdout" | "stderr";
  line: string;
  loggedAt: number;
  createdAt: number;
}

const SELECT_COLUMNS = "id, service_id, container_id, seq, stream, line, logged_at, created_at";

function toDto(row: ServiceLogRow): ServiceLogDto {
  return {
    id: row.id,
    serviceId: row.service_id,
    containerId: row.container_id,
    seq: row.seq,
    stream: row.stream,
    line: row.line,
    loggedAt: row.logged_at,
    createdAt: row.created_at,
  };
}

/**
 * N บรรทัด **ล่าสุด** — ใช้ตอนเปิดหน้า log ครั้งแรก
 *
 * ต้องใช้ตัวนี้ ไม่ใช่ listServiceLogs() แบบไม่มี cursor ซึ่งจะได้บรรทัด **เก่าสุด** ของ ring
 * buffer (ORDER BY seq ASC จาก 0) — ตรงข้ามกับที่คนเปิดดู log ต้องการ (บั๊กเดียวกับที่เคยทำให้
 * หน้า runtime log ของ project ค้างทั้งเบราว์เซอร์)
 *
 * คืนผลเรียงเก่า→ใหม่ เพื่อให้ผู้เรียกต่อท้าย stream ได้ตรง ๆ
 */
export function tailServiceLogs(db: Database, serviceId: string, limit = 200): ServiceLogDto[] {
  const capped = Math.min(Math.max(limit, 1), 500);
  return db
    .query<ServiceLogRow, [string, number]>(
      `SELECT ${SELECT_COLUMNS} FROM service_logs
       WHERE service_id = ?
       ORDER BY seq DESC
       LIMIT ?`,
    )
    .all(serviceId, capped)
    .reverse()
    .map(toDto);
}

/** rows ที่มี seq > afterSeq เรียง ASC — สำหรับ SSE polling ต่อจาก cursor */
export function listServiceLogs(
  db: Database,
  serviceId: string,
  opts: { afterSeq?: number; limit?: number } = {},
): ServiceLogDto[] {
  const afterSeq = opts.afterSeq ?? 0;
  const limit = Math.min(opts.limit ?? 500, 500);

  return db
    .query<ServiceLogRow, [string, number, number]>(
      `SELECT ${SELECT_COLUMNS} FROM service_logs
       WHERE service_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
    )
    .all(serviceId, afterSeq, limit)
    .map(toDto);
}
