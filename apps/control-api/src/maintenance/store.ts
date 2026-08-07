/**
 * Maintenance job store — Phase 11
 *
 * ADR-0002: control-api สร้างงาน, worker เป็นคนแตะ Docker
 * control-api อ่านผลจากตารางนี้เพื่อรายงานให้ UI เท่านั้น
 */

import type { Database } from "bun:sqlite";
import { AppError, ulid } from "@zixploy/shared";

export type MaintenanceType = "prune_build_cache" | "prune_images" | "prune_all";

export interface MaintenanceJobRow {
  id: string;
  type: string;
  status: string;
  reclaimed_bytes: number | null;
  summary: string | null;
  failure_message: string | null;
  requested_by: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

export interface MaintenanceJobDto {
  id: string;
  type: MaintenanceType;
  status: "pending" | "leased" | "done" | "failed";
  reclaimedBytes: number | null;
  summary: string | null;
  failureMessage: string | null;
  createdAt: number;
  finishedAt: number | null;
}

const SELECT_ALL = `id, type, status, reclaimed_bytes, summary, failure_message,
  requested_by, created_at, updated_at, finished_at`;

function toDto(row: MaintenanceJobRow): MaintenanceJobDto {
  return {
    id: row.id,
    type: row.type as MaintenanceType,
    status: row.status as MaintenanceJobDto["status"],
    reclaimedBytes: row.reclaimed_bytes,
    summary: row.summary,
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/**
 * สร้างงาน prune — ล้มด้วย MAINTENANCE_BUSY ถ้ามีงานค้างอยู่
 *
 * unique partial index บังคับหนึ่งงานค้างต่อระบบ: prune พร้อมกันหลายตัวจะชิงกันลบ layer
 * เดียวกัน ทำให้ตัวเลข reclaimed ที่รายงานเพี้ยนและ docker เองก็ error
 */
export function enqueueMaintenance(
  db: Database,
  type: MaintenanceType,
  requestedBy: string | null,
): MaintenanceJobDto {
  const now = Date.now();
  const id = ulid();

  try {
    db.query(
      `INSERT INTO maintenance_jobs (id, type, status, requested_by, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?)`,
    ).run(id, type, requestedBy, now, now);
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      throw new AppError("MAINTENANCE_BUSY", "มีงานล้าง cache กำลังทำงานอยู่ — รอให้เสร็จก่อน");
    }
    throw err;
  }

  const row = db
    .query<MaintenanceJobRow, [string]>(`SELECT ${SELECT_ALL} FROM maintenance_jobs WHERE id = ?`)
    .get(id);
  if (!row) throw new AppError("INTERNAL_ERROR", "maintenance job disappeared after insert");
  return toDto(row);
}

/** งานที่กำลังทำอยู่ (ถ้ามี) — UI ใช้แสดง spinner และปิดปุ่ม */
export function activeMaintenance(db: Database): MaintenanceJobDto | null {
  const row = db
    .query<MaintenanceJobRow, []>(
      `SELECT ${SELECT_ALL} FROM maintenance_jobs
        WHERE status IN ('pending', 'leased') LIMIT 1`,
    )
    .get();
  return row ? toDto(row) : null;
}

export function recentMaintenance(db: Database, limit = 5): MaintenanceJobDto[] {
  return db
    .query<MaintenanceJobRow, [number]>(
      `SELECT ${SELECT_ALL} FROM maintenance_jobs ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit)
    .map(toDto);
}
