/**
 * Log retention — Phase 6 M5
 *
 * pruneBuildLogs: ลบ build_logs ของ deployment ที่ finished_at เกิน retentionDays วัน
 * pruneRuntimeLogs: ตัด ring buffer per project ให้ไม่เกิน RUNTIME_LOG_RING_SIZE
 *
 * เรียกจาก cleanup job (deploy-worker pipeline/cleanup.ts) เป็น best-effort
 * ถ้า fail ไม่ throw — log warning แล้ว continue
 *
 * Disk watermark check: หา available disk space (Linux: df, Windows: wmic fallback)
 * Worker เรียก checkDiskPressure() ก่อน claim build job — ถ้าต่ำกว่า threshold
 * fail job ด้วย DISK_FULL error (ป้องกัน build แย่งพื้นที่ active container)
 */

import type { Database } from "bun:sqlite";
import { LOG_SETTINGS } from "@zixploy/shared";

// ---------------------------------------------------------------------------
// Build log retention
// ---------------------------------------------------------------------------

/**
 * ลบ build_logs ของ deployment ที่ finished_at เกิน retentionDays วัน
 * คืนจำนวน row ที่ลบ (0 ถ้าไม่มี)
 *
 * ลบ deployment เฉพาะที่ terminal state (succeeded/failed/cancelled)
 * เพื่อไม่ตัด log ของ deployment ที่กำลัง build อยู่
 */
export function pruneBuildLogs(
  db: Database,
  retentionDays: number = LOG_SETTINGS.buildRetentionDays,
): number {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  // ลบโดยอิงจาก deployment.finished_at (ไม่ใช่ build_logs.created_at เพื่อกันตัดกลางการ stream)
  const result = db
    .prepare(
      `DELETE FROM build_logs
     WHERE deployment_id IN (
       SELECT id FROM deployments
       WHERE status IN ('succeeded', 'failed', 'cancelled')
         AND finished_at IS NOT NULL
         AND finished_at < ?
     )`,
    )
    .run(cutoff);

  return result.changes;
}

// ---------------------------------------------------------------------------
// Runtime log ring buffer maintenance
// ---------------------------------------------------------------------------

/**
 * ตัด runtime_logs ของ project ให้ไม่เกิน ringSize บรรทัด
 * คืนจำนวน row ที่ลบ
 */
export function pruneRuntimeLogs(
  db: Database,
  projectId: string,
  ringSize: number = LOG_SETTINGS.runtimeRingSize,
): number {
  const result = db
    .prepare(
      `DELETE FROM runtime_logs
     WHERE project_id = ? AND seq <= (
       SELECT seq FROM runtime_logs
       WHERE project_id = ?
       ORDER BY seq DESC
       LIMIT 1 OFFSET ?
     )`,
    )
    .run(projectId, projectId, ringSize - 1);

  return result.changes;
}

// ---------------------------------------------------------------------------
// Disk watermark
// ---------------------------------------------------------------------------

/** ขนาด disk ขั้นต่ำก่อนปล่อยให้ build ใหม่ (500 MiB) */
const DISK_MIN_FREE_BYTES = 500 * 1024 * 1024;

export interface DiskInfo {
  availableBytes: number;
  totalBytes: number;
}

/**
 * อ่าน available disk space ของ partition ที่ tmpdir อยู่ (Linux: df, Windows: stub)
 * คืน null ถ้าไม่สามารถอ่านได้ (ถือว่า OK — fail open เพื่อไม่บล็อก build โดยไม่จำเป็น)
 */
export async function getDiskInfo(): Promise<DiskInfo | null> {
  try {
    const proc = Bun.spawn(["df", "-k", "--output=avail,size", "/"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) return null;

    const stdout = await new Response(proc.stdout).text();
    const lines = stdout.trim().split("\n");
    // line 0: header "Avail 1K-blocks" หรือ "Avail Size"
    // line 1: ค่าจริง
    const dataLine = lines[1]?.trim().split(/\s+/);
    if (!dataLine || dataLine.length < 2) return null;

    const availKb = Number(dataLine[0]);
    const totalKb = Number(dataLine[1]);
    if (Number.isNaN(availKb) || Number.isNaN(totalKb)) return null;

    return {
      availableBytes: availKb * 1024,
      totalBytes: totalKb * 1024,
    };
  } catch {
    return null;
  }
}

/**
 * คืน true ถ้า disk pressure สูง (available < DISK_MIN_FREE_BYTES)
 * คืน false ถ้าอ่านไม่ได้ (fail open)
 */
export async function checkDiskPressure(): Promise<boolean> {
  const info = await getDiskInfo();
  if (!info) return false; // fail open: ไม่บล็อกถ้าอ่านไม่ได้
  return info.availableBytes < DISK_MIN_FREE_BYTES;
}
