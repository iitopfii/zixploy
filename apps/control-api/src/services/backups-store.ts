/**
 * Managed service backup history — Phase 16
 *
 * ADR-0002: control-api ไม่แตะ Docker เลย — dump/restore จริงทำโดย worker เท่านั้น (ผ่าน
 * apps/deploy-worker/src/services/backup.ts) โมดูลนี้ทำแค่สองอย่าง:
 * 1. อ่าน/ลบแถวใน service_backups ที่ worker เป็นคนเขียน (control-api ไม่เคย INSERT/UPDATE)
 * 2. resolve path ของไฟล์ dump บน zixploy-backups volume เพื่อ stream ให้ผู้ใช้ดาวน์โหลด
 *
 * Layout ต้องตรงกับฝั่ง worker เป๊ะ — <backupsDir>/services/<serviceId>/<backupId>.<ext>
 * (ดู comment บนสุดของ backup.ts ฝั่ง worker) เพราะ mount volume เดียวกัน (zixploy-backups)
 * แค่คนละ container — ไม่มีทาง import ข้าม package ได้ตาม ADR-0002 จึง duplicate layout
 * ไว้ตรงนี้โดยตั้งใจ
 */

import type { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "@zixploy/shared";

/** mount point เดียวกับที่ deploy-worker ใช้ (ZIXPLOY_BACKUPS_DIR) — ต้องตรงกับ docker-compose.yml */
export const DEFAULT_BACKUPS_DIR = "/backups";

export function backupsDir(): string {
  return process.env.ZIXPLOY_BACKUPS_DIR ?? DEFAULT_BACKUPS_DIR;
}

function serviceBackupDir(serviceId: string): string {
  return join(backupsDir(), "services", serviceId);
}

export interface BackupRow {
  id: string;
  service_id: string;
  trigger: string;
  status: string;
  file_name: string | null;
  size_bytes: number | null;
  failure_message: string | null;
  started_at: number;
  finished_at: number | null;
  created_at: number;
}

export interface BackupDto {
  id: string;
  serviceId: string;
  trigger: "manual" | "scheduled";
  status: "running" | "succeeded" | "failed";
  fileName: string | null;
  sizeBytes: number | null;
  failureMessage: string | null;
  startedAt: number;
  finishedAt: number | null;
  createdAt: number;
}

const SELECT_ALL = `
  id, service_id, trigger, status, file_name, size_bytes, failure_message,
  started_at, finished_at, created_at
`;

export function toDto(row: BackupRow): BackupDto {
  return {
    id: row.id,
    serviceId: row.service_id,
    trigger: row.trigger as BackupDto["trigger"],
    status: row.status as BackupDto["status"],
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    failureMessage: row.failure_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

export function listBackups(db: Database, serviceId: string): BackupDto[] {
  return db
    .query<BackupRow, [string]>(
      `SELECT ${SELECT_ALL} FROM service_backups WHERE service_id = ? ORDER BY created_at DESC`,
    )
    .all(serviceId)
    .map(toDto);
}

/** โยน SERVICE_BACKUP_NOT_FOUND ถ้าไม่เจอ หรือเจอแต่เป็นของ service อื่น (กัน id เดาข้าม service) */
export function requireBackupRow(db: Database, serviceId: string, backupId: string): BackupRow {
  const row = db
    .query<BackupRow, [string]>(`SELECT ${SELECT_ALL} FROM service_backups WHERE id = ?`)
    .get(backupId);
  if (!row || row.service_id !== serviceId) {
    throw new AppError("SERVICE_BACKUP_NOT_FOUND", "ไม่พบ backup นี้");
  }
  return row;
}

/** path เต็มของไฟล์บน disk — โยนถ้ายังไม่เสร็จหรือไฟล์หายไปจากดิสก์แล้ว */
export function resolveBackupFilePath(serviceId: string, row: BackupRow): string {
  if (row.status !== "succeeded" || !row.file_name) {
    throw new AppError("SERVICE_BACKUP_NOT_READY", "backup นี้ยังไม่พร้อมใช้งาน");
  }
  const path = join(serviceBackupDir(serviceId), row.file_name);
  if (!existsSync(path)) {
    throw new AppError("SERVICE_BACKUP_NOT_FOUND", "ไฟล์ backup หายไปจากดิสก์แล้ว");
  }
  return path;
}

/**
 * ลบทั้งแถวใน DB และไฟล์จริง — กันลบ backup ที่กำลังรันอยู่ (worker เขียนไฟล์ค้างอยู่ตอนนั้น
 * ลบไปแล้ว worker เขียนต่อจะกลายเป็นไฟล์กำพร้าไม่มีแถวอ้างอิง)
 */
export function deleteBackup(db: Database, serviceId: string, backupId: string): void {
  const row = requireBackupRow(db, serviceId, backupId);
  if (row.status === "running") {
    throw new AppError("SERVICE_BACKUP_NOT_READY", "backup นี้กำลังทำงานอยู่ — รอให้เสร็จก่อนลบ");
  }
  if (row.file_name) {
    try {
      rmSync(join(serviceBackupDir(serviceId), row.file_name), { force: true });
    } catch {
      // best-effort — ไฟล์อาจถูกลบไปแล้ว/สิทธิ์ไม่พอ ไม่ให้กระทบการลบแถว DB
    }
  }
  db.query("DELETE FROM service_backups WHERE id = ?").run(backupId);
}
