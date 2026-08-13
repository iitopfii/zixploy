/**
 * Scheduled service backups — Phase 16
 *
 * ไม่ผ่าน service_jobs queue เลย — รูปแบบเดียวกับ runtimeLogLoop/metricsLoop ที่ poll DB แล้ว
 * ทำงานเองได้โดยไม่ต้องมี job (ADR-0002 ห้าม worker INSERT ลง service_jobs เท่านั้น ไม่ได้ห้าม
 * background loop อื่นที่ทำงานจากการอ่าน DB ตรง ๆ)
 *
 * ทุก scheduleCheckIntervalMs: หา service ที่เปิด backup_enabled ไว้และถึงกำหนดแล้ว
 * (now - last_backup_at >= backup_interval_hours ชั่วโมง หรือไม่เคย backup เลย) แล้วเรียก
 * runBackup() ตรง ๆ ทีละตัว — ไม่ทำพร้อมกันหลาย service กันแย่ง I/O ของ Docker daemon
 *
 * ข้าม service ที่มีงานอื่นค้างอยู่ใน service_jobs (pending/leased) กัน backup ชนกับ
 * provision/start/stop/restart/destroy/backup(manual)/restore ที่กำลังทำอยู่บน container เดียวกัน
 */

import type { Database } from "bun:sqlite";
import { SERVICE_BACKUP_SETTINGS } from "@zixploy/shared";
import type { DockerCliClient } from "../docker/cli-client";
import { runBackup } from "./backup";
import { listServicesWithBackupEnabled } from "./provision";

function hasActiveJob(db: Database, serviceId: string): boolean {
  const row = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM service_jobs WHERE service_id = ? AND status IN ('pending', 'leased') LIMIT 1",
    )
    .get(serviceId);
  return row !== null;
}

function isDue(lastBackupAt: number | null, intervalHours: number, now: number): boolean {
  if (lastBackupAt === null) return true;
  return now - lastBackupAt >= intervalHours * 60 * 60 * 1000;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

export async function backupScheduleLoop(
  db: Database,
  docker: DockerCliClient,
  backupsDir: string,
  signal: AbortSignal,
  onLog: (line: string) => void = () => {},
): Promise<void> {
  while (!signal.aborted) {
    try {
      const now = Date.now();
      const services = listServicesWithBackupEnabled(db);

      for (const row of services) {
        if (signal.aborted) break;
        if (!isDue(row.last_backup_at, row.backup_interval_hours as number, now)) continue;
        if (hasActiveJob(db, row.id)) continue;

        try {
          onLog(`scheduled backup ถึงกำหนดแล้ว: "${row.name}"`);
          await runBackup({ db, docker, backupsDir, onLog }, row.id, "scheduled");
        } catch (err) {
          // runBackup บันทึกลง service_backups.failure_message ไปแล้ว — แค่ log ต่อไม่ให้ loop ตาย
          onLog(
            `scheduled backup ล้มเหลว: "${row.name}" — ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch {
      // DB error ชั่วคราว — รอรอบหน้า ไม่ crash worker
    }

    await sleep(SERVICE_BACKUP_SETTINGS.scheduleCheckIntervalMs, signal);
  }
}
