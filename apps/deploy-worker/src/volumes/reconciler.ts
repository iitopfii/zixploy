/**
 * Volume reconciler — Phase 7 M5
 *
 * Background loop ที่รันคู่กับ heartbeatLoop + jobLoop + runtimeLogLoop ใน index.ts
 *
 * ทุก VOLUME_RECONCILE_INTERVAL_MS:
 * 1. Deletion pending → `docker volume rm` → lifecycle='deleted'
 * 2. Active/detached → ตรวจว่า Docker volume มีอยู่จริง
 *    - ไม่มีอยู่ → lifecycle='error' (orphan detection — report-only ตาม phase doc)
 *
 * Architecture constraints:
 * - control-api ไม่แตะ Docker ตาม ADR-0002 — reconciler อยู่ใน worker เท่านั้น
 * - Worker เดียวทำงาน (single-writer design) — ไม่มี race ระหว่าง workers
 * - fail-open: error ในการ reconcile volume เดียวไม่ crash loop
 */

import type { Database } from "bun:sqlite";
import type { DockerCliClient } from "../docker/cli-client";

const VOLUME_RECONCILE_INTERVAL_MS = 30_000; // reconcile ทุก 30 วินาที

interface VolumeRow {
  id: string;
  docker_name: string;
  lifecycle: string;
}

function listNonDeletedVolumes(db: Database): VolumeRow[] {
  return db
    .query<VolumeRow, []>(
      `SELECT id, docker_name, lifecycle
       FROM volumes
       WHERE lifecycle NOT IN ('deleted')
       ORDER BY created_at`,
    )
    .all();
}

function setVolumeLifecycle(db: Database, volumeId: string, lifecycle: string): void {
  db.query("UPDATE volumes SET lifecycle = ?, updated_at = ? WHERE id = ?").run(
    lifecycle,
    Date.now(),
    volumeId,
  );
}

/**
 * Reconcile one round:
 * - deletion_pending → docker volume rm → deleted (หรือ error ถ้า in-use)
 * - active/detached/error → ตรวจว่า Docker volume มีอยู่จริง → error ถ้าไม่มี
 */
async function reconcileOnce(db: Database, docker: DockerCliClient): Promise<void> {
  const volumes = listNonDeletedVolumes(db);

  for (const vol of volumes) {
    try {
      if (vol.lifecycle === "deletion_pending") {
        // พยายาม rm — docker.removeVolume คืน VOLUME_IN_USE ถ้ายังมี container ใช้
        await docker.removeVolume(vol.docker_name);
        setVolumeLifecycle(db, vol.id, "deleted");
      } else {
        // active / detached / error — ตรวจว่า Docker volume มีอยู่จริง
        const info = await docker.inspectVolume(vol.docker_name);
        if (!info) {
          // orphan: DB record อยู่ แต่ Docker volume หาย — อาจถูกลบมือ
          if (vol.lifecycle !== "error") {
            setVolumeLifecycle(db, vol.id, "error");
          }
        } else if (vol.lifecycle === "error") {
          // Docker volume กลับมามีอยู่ (recreated) — ยังไม่ auto-recover lifecycle
          // เพราะต้องการ explicit action จาก admin (detach/re-attach)
        }
      }
    } catch {
      // ข้าม volume นี้รอบนี้ — ไม่ crash loop (fail-open)
    }
  }
}

/**
 * Background reconcile loop — รัน parallel กับ heartbeatLoop + jobLoop
 *
 * @param db      SQLite connection (เดียวกับที่ worker ใช้)
 * @param docker  DockerCliClient สำหรับ volume inspect / rm
 * @param signal  AbortSignal จาก global AbortController ของ worker
 */
export async function volumeReconcileLoop(
  db: Database,
  docker: DockerCliClient,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await reconcileOnce(db, docker);
    } catch {
      // DB error หรืออื่นๆ — รอแล้วลองใหม่รอบหน้า ไม่ crash worker
    }

    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, VOLUME_RECONCILE_INTERVAL_MS);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
