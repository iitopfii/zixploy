/**
 * Volume reconciler — Phase 7 M5
 *
 * Background loop ที่รันคู่กับ heartbeatLoop + jobLoop + runtimeLogLoop ใน index.ts
 *
 * ทุก VOLUME_RECONCILE_INTERVAL_MS:
 * 1. Deletion pending → `docker volume rm` → lifecycle='deleted'
 *    - ลบไม่ได้ → คง deletion_pending + เขียน last_error บอกสาเหตุ (เช่น VOLUME_IN_USE
 *      ต้อง redeploy ก่อน) — ผู้ใช้เคยเห็น "รอ worker ลบ…" ค้างตลอดกาลโดยไม่รู้สาเหตุ
 * 2. Active/detached/error → ตรวจว่า Docker volume มีอยู่จริง
 *    - ไม่มี + ไม่เคยถูก mount (last_attached_at NULL) → ไม่ใช่ orphan: Docker volume
 *      จริงถูกสร้างตอน deploy เท่านั้น volume ที่เพิ่งสร้างใน UI จึงยังไม่มีเสมอ —
 *      สร้างให้เลย (idempotent) แทนการตีตรา error (บทเรียน 2026-08-20: volume ใหม่
 *      กลายเป็น error เสมอถ้ายัง redeploy ไม่ทัน แล้วไม่มีทางกลับมา active)
 *    - ไม่มี + เคยถูกใช้งานจริง → orphan จริง: lifecycle='error' + last_error ชี้ runbook
 *
 * Architecture constraints:
 * - control-api ไม่แตะ Docker ตาม ADR-0002 — reconciler อยู่ใน worker เท่านั้น
 * - Worker เดียวทำงาน (single-writer design) — ไม่มี race ระหว่าง workers
 * - fail-open: error ในการ reconcile volume เดียวไม่ crash loop
 */

import type { Database } from "bun:sqlite";
import { AppError } from "@zixploy/shared";
import type { DockerCliClient } from "../docker/cli-client";
import { parseDriverOpts } from "./loader";

const VOLUME_RECONCILE_INTERVAL_MS = 30_000; // reconcile ทุก 30 วินาที

// last_error โชว์ตรงใน dashboard — ตัดสั้นกันข้อความ Docker ยาวๆ ล้นการ์ด UI
const LAST_ERROR_MAX_LENGTH = 200;

interface VolumeRow {
  id: string;
  docker_name: string;
  lifecycle: string;
  driver: string;
  driver_opts: string;
  last_attached_at: number | null;
}

function listNonDeletedVolumes(db: Database): VolumeRow[] {
  return db
    .query<VolumeRow, []>(
      `SELECT id, docker_name, lifecycle, driver, driver_opts, last_attached_at
       FROM volumes
       WHERE lifecycle NOT IN ('deleted')
       ORDER BY created_at`,
    )
    .all();
}

function setVolumeLifecycle(
  db: Database,
  volumeId: string,
  lifecycle: string,
  lastError: string | null,
): void {
  db.query("UPDATE volumes SET lifecycle = ?, last_error = ?, updated_at = ? WHERE id = ?").run(
    lifecycle,
    lastError,
    Date.now(),
    volumeId,
  );
}

/** เขียนเฉพาะ last_error โดยไม่แตะ lifecycle (ใช้ตอนคง deletion_pending ไว้รอบหน้า) */
function setVolumeLastError(db: Database, volumeId: string, lastError: string): void {
  db.query("UPDATE volumes SET last_error = ?, updated_at = ? WHERE id = ?").run(
    lastError.slice(0, LAST_ERROR_MAX_LENGTH),
    Date.now(),
    volumeId,
  );
}

/**
 * Reconcile one round:
 * - deletion_pending → docker volume rm → deleted (fail → คงสถานะ + last_error บอกสาเหตุ)
 * - active/detached/error ที่ Docker volume หาย:
 *   - ไม่เคย attach → auto-create (+ heal error → active)
 *   - เคย attach → error + last_error
 */
async function reconcileOnce(db: Database, docker: DockerCliClient): Promise<void> {
  const volumes = listNonDeletedVolumes(db);

  for (const vol of volumes) {
    try {
      if (vol.lifecycle === "deletion_pending") {
        try {
          // พยายาม rm — docker.removeVolume คืน VOLUME_IN_USE ถ้ายังมี container ใช้
          await docker.removeVolume(vol.docker_name);
          setVolumeLifecycle(db, vol.id, "deleted", null);
        } catch (err) {
          // คง deletion_pending ไว้ลองรอบหน้า แต่เขียนสาเหตุให้ผู้ใช้เห็น —
          // เดิมค้าง "รอ worker ลบ…" เงียบๆ โดย user ไม่มีทางรู้ว่าติดอะไร
          const message =
            err instanceof AppError && err.code === "VOLUME_IN_USE"
              ? "ยังมี container ใช้ volume นี้อยู่ — จะถูกลบอัตโนมัติหลัง redeploy (container ใหม่จะไม่ mount volume นี้)"
              : err instanceof Error
                ? err.message
                : String(err);
          setVolumeLastError(db, vol.id, message);
        }
      } else {
        // active / detached / error — ตรวจว่า Docker volume มีอยู่จริง
        const info = await docker.inspectVolume(vol.docker_name);
        if (!info) {
          if (vol.last_attached_at === null) {
            // ยังไม่เคยถูก mount = ไม่ใช่ orphan — Docker volume จริงเกิดตอน deploy เท่านั้น
            // สร้างให้เลยด้วย labels ชุดเดียวกับ pipeline (idempotent) แทนการตีตรา error
            // bind mount ต้องส่ง driver_opts ด้วย — ไม่งั้นถูกสร้างผิดเป็น volume เปล่า
            // แล้ว deploy รอบถัดไปจะ mount ผิดที่แบบเงียบ ๆ (opts เปลี่ยนหลังสร้างไม่ได้)
            const driverOpts = parseDriverOpts(vol.driver_opts);
            await docker.createVolume({
              name: vol.docker_name,
              driver: vol.driver,
              labels: { "platform.managed": "true", "platform.volume_id": vol.id },
              ...(Object.keys(driverOpts).length > 0 ? { opts: driverOpts } : {}),
            });
            if (vol.lifecycle === "error") {
              // auto-heal false positive จากเวอร์ชันก่อนที่ตีตรา error ทั้งที่แค่ยังไม่ deploy
              setVolumeLifecycle(db, vol.id, "active", null);
            }
          } else if (vol.lifecycle !== "error") {
            // เคยถูกใช้งานจริงแล้ว Docker volume หาย = ผิดปกติจริง (อาจถูกลบมือ)
            setVolumeLifecycle(
              db,
              vol.id,
              "error",
              "Docker volume หายไปทั้งที่เคยถูกใช้งาน — อาจถูกลบด้วยมือ ดู docs/runbooks/volume-backup-restore.md สำหรับการกู้คืน",
            );
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
 * @param docker  DockerCliClient สำหรับ volume inspect / create / rm
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
