/**
 * General state reconciliation loop — Phase 8 M2 (docs/phase-08-production.md "Reconciliation")
 *
 * Background loop ที่รันคู่กับ heartbeatLoop + jobLoop + runtimeLogLoop + volumeReconcileLoop
 * ใน index.ts ต่างจาก volumes/reconciler.ts (Phase 7) ตรงที่ตัวนี้ดูภาพรวม project/container
 * ไม่ใช่เฉพาะ volume lifecycle
 *
 * ครอบคลุมใน M2:
 * 1. Active container หาย (project.status='running' แต่ container ของ deployment ล่าสุดที่ succeeded
 *    ไม่มีอยู่จริงใน Docker) → mark project degraded — ต้อง redeploy manual เพื่อกลับมา running
 * 2. Container orphan ที่มี ownership labels (platform.managed=true) แต่ deployment_id ใน label
 *    ไม่ตรงกับ deployment ใด ๆ ใน DB ของ project นั้น → report-only (log) ไม่ auto-remove
 *    (ตาม phase doc: "quarantine/report ก่อน cleanup")
 *
 * ยังไม่ครอบคลุมใน M2 (ดู docs/phase-08-production.md งานดำเนินการ M2 หมายเหตุ):
 * - "DB บอก deploying แต่ไม่มี worker lease" — ครอบคลุมแล้วโดย recoverStaleLeases() ซึ่งรันทุกครั้งที่
 *   jobLoop เรียก claimNextJob() (ทุก DEPLOY_QUEUE.pollIntervalMs อยู่แล้ว ไม่ต้องมี loop แยก)
 * - Domain route readiness recheck (ต้องพึ่ง Traefik state ที่ยังไม่มี adapter)
 * - Installation ถูกถอนสิทธิ์ → disable source actions (ต้องมี GitHub installation webhook handler
 *   แยกต่างหาก — เป็น milestone ของตัวเอง)
 *
 * Architecture constraints (เหมือน volumes/reconciler.ts):
 * - control-api ไม่แตะ Docker ตาม ADR-0002 — reconciler อยู่ใน worker เท่านั้น
 * - fail-open: error ใน project/container เดียวไม่ crash loop ทั้งหมด
 */

import type { Database } from "bun:sqlite";
import { LABELS } from "@zixploy/shared";
import { markProjectDegraded } from "./db/project-config";
import type { DockerCliClient } from "./docker/cli-client";

const STATE_RECONCILE_INTERVAL_MS = 30_000;

interface RunningProjectRow {
  id: string;
  container_id: string | null;
}

/** project ที่ status='running' พร้อม container_id ของ deployment ที่ succeeded ล่าสุด */
function listRunningProjectsWithContainer(db: Database): RunningProjectRow[] {
  return db
    .query<RunningProjectRow, []>(
      `SELECT p.id as id,
              (SELECT d.container_id FROM deployments d
               WHERE d.project_id = p.id AND d.status = 'succeeded' AND d.container_id IS NOT NULL
               ORDER BY d.finished_at DESC LIMIT 1) as container_id
       FROM projects p
       WHERE p.status = 'running' AND p.archived_at IS NULL`,
    )
    .all();
}

/** แปลง Docker `--format {{json .}}` Labels field (comma-separated "k=v,k2=v2") เป็น map */
function parseLabelString(labelsStr: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of labelsStr.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    out[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return out;
}

function deploymentExists(db: Database, deploymentId: string, projectId: string): boolean {
  const row = db
    .query<{ id: string }, [string, string]>(
      "SELECT id FROM deployments WHERE id = ? AND project_id = ?",
    )
    .get(deploymentId, projectId);
  return row != null;
}

/** M2.1: project ที่ควร running แต่ active container หายไปจริง → mark degraded */
async function reconcileMissingContainers(
  db: Database,
  docker: DockerCliClient,
  onLog: (line: string) => void,
): Promise<void> {
  for (const row of listRunningProjectsWithContainer(db)) {
    if (!row.container_id) continue; // ไม่เคยมี succeeded deployment — ไม่ควรเกิดถ้า status='running' แต่ข้ามอย่างปลอดภัย
    try {
      const info = await docker.inspectContainer(row.container_id);
      if (!info && markProjectDegraded(db, row.id)) {
        onLog(
          `[reconcile] project ${row.id}: active container ${row.container_id} หายไปจาก Docker — mark degraded (ต้อง redeploy)`,
        );
      }
    } catch {
      // fail-open — ข้าม project นี้รอบนี้ ลองใหม่รอบหน้า
    }
  }
}

/** M2.2: container ที่มี ownership labels แต่ deployment_id ไม่ตรงกับ DB ของ project นั้น → report-only */
async function reconcileOrphanContainers(
  db: Database,
  docker: DockerCliClient,
  onLog: (line: string) => void,
): Promise<void> {
  let containers: Array<{ ID: string; Labels: string }>;
  try {
    containers = await docker.listContainersByLabel({ [LABELS.managed]: "true" });
  } catch {
    return; // Docker daemon ไม่พร้อม — ข้ามรอบนี้ทั้งหมด (fail-open)
  }

  for (const c of containers) {
    const labels = parseLabelString(c.Labels);
    const projectId = labels[LABELS.projectId];
    const deploymentId = labels[LABELS.deploymentId];
    if (!projectId || !deploymentId) continue; // label ไม่ครบ — ไม่ใช่ resource ของเราจริง ๆ ข้าม

    try {
      if (!deploymentExists(db, deploymentId, projectId)) {
        onLog(
          `[reconcile] orphan container ${c.ID} (project=${projectId}, deployment=${deploymentId}) ` +
            "ไม่มี deployment record ตรงกันใน DB — report-only ไม่ลบอัตโนมัติ (ตรวจสอบด้วยมือ)",
        );
      }
    } catch {
      // fail-open — ข้าม container นี้รอบนี้
    }
  }
}

/** เรียกตรงได้จากเทสต์ (reconciler.test.ts) โดยไม่ต้องพึ่ง timing ของ setTimeout/AbortSignal ของ loop */
export async function reconcileOnce(
  db: Database,
  docker: DockerCliClient,
  onLog: (line: string) => void = () => {},
): Promise<void> {
  await reconcileMissingContainers(db, docker, onLog);
  await reconcileOrphanContainers(db, docker, onLog);
}

/**
 * Background reconcile loop — รัน parallel กับ heartbeatLoop + jobLoop + runtimeLogLoop + volumeReconcileLoop
 *
 * @param db      SQLite connection (เดียวกับที่ worker ใช้)
 * @param docker  DockerCliClient สำหรับ container inspect/list
 * @param signal  AbortSignal จาก global AbortController ของ worker
 * @param onLog   เรียกทุกครั้งที่พบ degraded/orphan — default no-op (ผู้เรียกต่อกับ logger เอง)
 */
export async function stateReconcileLoop(
  db: Database,
  docker: DockerCliClient,
  signal: AbortSignal,
  onLog: (line: string) => void = () => {},
): Promise<void> {
  while (!signal.aborted) {
    try {
      await reconcileOnce(db, docker, onLog);
    } catch {
      // DB error หรืออื่นๆ — รอแล้วลองใหม่รอบหน้า ไม่ crash worker
    }

    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, STATE_RECONCILE_INTERVAL_MS);
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
