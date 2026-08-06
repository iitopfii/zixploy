/**
 * Deploy job queue mechanics — claim/lease/renew/recover (ADR-0002, ADR-0003)
 *
 * Worker เป็นฝ่ายเดียวที่ claim/update งานใน deploy_jobs — ไม่เคย INSERT งานใหม่
 * (control-api เป็นคนตัดสินใจว่า "ต้องมีงานนี้" เสมอ — ดู apps/control-api/src/deploys/queue.ts)
 *
 * Lease design: claim ตั้ง lease_expires_at = now + leaseMs; withLeaseRenewal ต่ออายุเป็น
 * ระยะ ๆ ระหว่างทำงาน; ถ้า renew ไม่สำเร็จ (lease หลุดไปแล้ว) หรือมีคน request cancel
 * jobSignal ที่ส่งให้ processJob จะถูก abort
 */

import type { Database } from "bun:sqlite";
import { DEPLOY_QUEUE, type DeploymentStatus, isTerminal } from "@zixploy/shared";

export interface ClaimedJob {
  id: string;
  projectId: string;
  deploymentId: string | null;
  type: "deploy" | "cleanup";
  status: "leased";
  /** JSON.parse แล้ว — ผู้เรียกต้อง narrow เองตาม payload.kind */
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

export type JobOutcome = { outcome: "done" } | { outcome: "failed"; retryable: boolean };

export class LeaseLostError extends Error {
  constructor(readonly reason: "expired" | "cancelled") {
    super(`deploy job lease lost (${reason}) — ownership no longer held`);
    this.name = "LeaseLostError";
  }
}

interface JobRow {
  id: string;
  project_id: string;
  deployment_id: string | null;
  type: string;
  payload: string;
  attempts: number;
  max_attempts: number;
}

function toClaimedJob(row: JobRow): ClaimedJob {
  return {
    id: row.id,
    projectId: row.project_id,
    deploymentId: row.deployment_id,
    type: row.type as "deploy" | "cleanup",
    status: "leased",
    payload: JSON.parse(row.payload),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

/**
 * Flip stale leased job กลับเป็น pending (ถ้ายัง retry ได้) หรือ failed (attempts หมดแล้ว)
 * — worker เดิมถือว่าตายไปแล้ว (lease หมดอายุไม่มีคนต่อ) เรียกที่จุดเริ่มของทุก claim attempt
 * เพื่อ self-heal โดยไม่ต้องมี sweep process แยก
 *
 * เมื่อ attempts หมด: mark deployment ที่ผูกอยู่ (ถ้ามีและยังไม่ terminal) เป็น failed ด้วย
 */
export function recoverStaleLeases(db: Database, now: number = Date.now()): number {
  const stale = db
    .query<
      { id: string; deployment_id: string | null; attempts: number; max_attempts: number },
      [number]
    >(
      "SELECT id, deployment_id, attempts, max_attempts FROM deploy_jobs WHERE status = 'leased' AND lease_expires_at < ?",
    )
    .all(now);

  let recovered = 0;
  for (const job of stale) {
    const retryable = job.attempts < job.max_attempts;
    const run = db.transaction(() => {
      if (retryable) {
        db.query(
          "UPDATE deploy_jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'leased'",
        ).run(now, job.id);
        return;
      }

      db.query(
        "UPDATE deploy_jobs SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'leased'",
      ).run(now, job.id);

      if (job.deployment_id) {
        const deployment = db
          .query<{ status: string }, [string]>("SELECT status FROM deployments WHERE id = ?")
          .get(job.deployment_id);
        if (deployment && !isTerminal(deployment.status as DeploymentStatus)) {
          db.query(
            `UPDATE deployments
             SET status = 'failed', failure_code = 'WORKER_LEASE_EXPIRED',
                 failure_message = 'worker หยุดทำงานกลางทางและ retry attempts หมดแล้ว',
                 finished_at = ?, updated_at = ?
             WHERE id = ?`,
          ).run(now, now, job.deployment_id);
        }
      }
    });
    run();
    recovered++;
  }
  return recovered;
}

/**
 * Atomic claim: recoverStaleLeases() ก่อน แล้ว SELECT+UPDATE (compare-and-set) ในธุรกรรมเดียว
 * เลือก priority สูงสุดก่อน แล้ว created_at เก่าสุด — คืน null ถ้าไม่มีงาน pending
 */
export function claimNextJob(db: Database, workerId: string, leaseMs: number): ClaimedJob | null {
  recoverStaleLeases(db);

  const claim = db.transaction((): ClaimedJob | null => {
    const now = Date.now();
    const candidate = db
      .query<{ id: string }, []>(
        "SELECT id FROM deploy_jobs WHERE status = 'pending' ORDER BY priority DESC, created_at ASC LIMIT 1",
      )
      .get();
    if (!candidate) return null;

    const result = db
      .query(
        "UPDATE deploy_jobs SET status = 'leased', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(workerId, now + leaseMs, now, candidate.id);
    // changes === 0 หมายถึงมีคน claim ไปพร้อมกันในนาทีเดียวกัน (หลาย worker instance) — ปล่อยให้ caller ลอง claim ใหม่รอบถัดไป
    if (result.changes === 0) return null;

    const row = db
      .query<JobRow, [string]>(
        "SELECT id, project_id, deployment_id, type, payload, attempts, max_attempts FROM deploy_jobs WHERE id = ?",
      )
      .get(candidate.id);
    if (!row) return null;
    return toClaimedJob(row);
  });

  return claim();
}

/**
 * ต่ออายุ lease ที่ยัง owned อยู่ — คืน false ถ้า lease หลุดไปแล้ว (ถูก recover/steal/ไม่ leased แล้ว)
 * caller (withLeaseRenewal) ต้อง abort เมื่อคืน false
 */
export function renewLease(
  db: Database,
  jobId: string,
  workerId: string,
  leaseMs: number,
): boolean {
  const now = Date.now();
  const result = db
    .query(
      "UPDATE deploy_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND status = 'leased'",
    )
    .run(now + leaseMs, now, jobId, workerId);
  return result.changes > 0;
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

/**
 * รัน fn(signal) พร้อมต่ออายุ lease เป็นระยะในพื้นหลัง
 * signal จะถูก abort ถ้า renewLease คืน false (lease หลุด) หรือ cancel_requested_at ถูกตั้งค่า
 * เมื่อ fn จบ (ปกติหรือ throw) จะหยุดต่ออายุทันที; ถ้า lease หลุดไปแล้วระหว่างทาง
 * จะโยน LeaseLostError แม้ fn จะ resolve สำเร็จ (fn อาจไม่สนใจ signal เอง)
 *
 * options เปิดให้ override interval/lease สำหรับเทสต์ — ปกติใช้ค่า default จาก DEPLOY_QUEUE
 */
export async function withLeaseRenewal<T>(
  db: Database,
  job: ClaimedJob,
  workerId: string,
  fn: (signal: AbortSignal) => Promise<T>,
  options?: { renewIntervalMs?: number; leaseMs?: number },
): Promise<T> {
  const renewIntervalMs = options?.renewIntervalMs ?? DEPLOY_QUEUE.leaseRenewIntervalMs;
  const leaseMs = options?.leaseMs ?? DEPLOY_QUEUE.leaseMs;

  const controller = new AbortController();
  let stopped = false;
  let lostReason: "expired" | "cancelled" | null = null;

  async function renewLoop(): Promise<void> {
    while (!stopped) {
      await sleep(renewIntervalMs, controller.signal);
      if (stopped) return;

      const renewed = renewLease(db, job.id, workerId, leaseMs);
      if (!renewed) {
        lostReason = "expired";
        controller.abort();
        return;
      }

      const row = db
        .query<{ cancel_requested_at: number | null }, [string]>(
          "SELECT cancel_requested_at FROM deploy_jobs WHERE id = ?",
        )
        .get(job.id);
      if (row?.cancel_requested_at != null) {
        lostReason = "cancelled";
        controller.abort();
        return;
      }
    }
  }

  const renewPromise = renewLoop();
  let result: T;
  try {
    result = await fn(controller.signal);
  } catch (err) {
    stopped = true;
    controller.abort();
    await renewPromise;
    // lease หลุดคือสาเหตุจริง — fn มักโยน error ของตัวเองแค่เพราะสังเกตเห็น signal ถูก abort
    // (เช่น subprocess ถูก kill กลางทาง) ซึ่งไม่ใช่ error ทางธุรกิจจริง ต้องบัง LeaseLostError ทับ
    // ไม่งั้น caller จะเข้าใจผิดว่างานล้มเหลวจริงแล้วไปเรียก completeJob/failJob บนงานที่ไม่ได้ถือ lease แล้ว
    if (lostReason) throw new LeaseLostError(lostReason);
    throw err;
  }

  stopped = true;
  controller.abort();
  await renewPromise;

  if (lostReason) throw new LeaseLostError(lostReason);
  return result;
}

export function completeJob(db: Database, jobId: string): void {
  db.query(
    "UPDATE deploy_jobs SET status = 'done', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
  ).run(Date.now(), jobId);
}

/**
 * retryable=true: requeue เป็น pending ถ้า attempts < max_attempts เท่านั้น ไม่งั้น fail ถาวร
 * retryable=false: fail ถาวรทันที (ใช้กับ build error ที่ไม่มีประโยชน์จะ retry ซ้ำ)
 */
export function failJob(db: Database, jobId: string, opts: { retryable: boolean }): void {
  const now = Date.now();
  if (opts.retryable) {
    const row = db
      .query<{ attempts: number; max_attempts: number }, [string]>(
        "SELECT attempts, max_attempts FROM deploy_jobs WHERE id = ?",
      )
      .get(jobId);
    if (row && row.attempts < row.max_attempts) {
      db.query(
        "UPDATE deploy_jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
      ).run(now, jobId);
      return;
    }
  }
  db.query(
    "UPDATE deploy_jobs SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
  ).run(now, jobId);
}
