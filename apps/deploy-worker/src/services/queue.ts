/**
 * Service job queue mechanics — Phase 10 M3
 *
 * โครงเดียวกับ deploy queue (apps/deploy-worker/src/queue.ts): claim ด้วย transaction,
 * ต่ออายุ lease ระหว่างทำงาน, recover งานที่ lease หมดอายุเพราะ worker ตาย
 *
 * ADR-0002: worker **ไม่เคย INSERT** งานใหม่ — claim/update งานที่ control-api สร้างไว้เท่านั้น
 */

import type { Database } from "bun:sqlite";
import { DEPLOY_QUEUE } from "@zixploy/shared";

export type ServiceJobType = "provision" | "start" | "stop" | "restart" | "destroy";

export interface ClaimedServiceJob {
  id: string;
  serviceId: string;
  type: ServiceJobType;
  attempts: number;
  maxAttempts: number;
}

interface JobRow {
  id: string;
  service_id: string;
  type: string;
  attempts: number;
  max_attempts: number;
}

/**
 * คืนงานที่ lease หมดอายุกลับเป็น pending — worker ตายกลางทางแล้วไม่มีใครปล่อย lease
 *
 * เกิน max_attempts → failed ถาวร ไม่วนซ้ำไม่รู้จบ (งาน provision ที่พังเพราะ image ไม่มีจริง
 * จะพังเหมือนเดิมทุกครั้ง — ปล่อยให้ retry ไม่จบเปลืองทรัพยากรเปล่า)
 */
export function recoverStaleServiceLeases(db: Database, now = Date.now()): number {
  const recovered = db
    .query(
      `UPDATE service_jobs
          SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
              lease_owner = NULL,
              lease_expires_at = NULL,
              failure_message = CASE WHEN attempts >= max_attempts
                                     THEN 'worker หยุดทำงานระหว่างดำเนินการและ retry ครบแล้ว'
                                     ELSE failure_message END,
              updated_at = ?
        WHERE status = 'leased' AND lease_expires_at < ?`,
    )
    .run(now, now);
  return recovered.changes ?? 0;
}

/** claim งานถัดไปแบบ atomic — คืน null เมื่อไม่มีงาน */
export function claimNextServiceJob(
  db: Database,
  workerId: string,
  leaseMs = DEPLOY_QUEUE.leaseMs,
): ClaimedServiceJob | null {
  recoverStaleServiceLeases(db);

  const now = Date.now();
  let claimed: ClaimedServiceJob | null = null;

  db.transaction(() => {
    const row = db
      .query<JobRow, []>(
        `SELECT id, service_id, type, attempts, max_attempts
           FROM service_jobs
          WHERE status = 'pending'
          ORDER BY created_at
          LIMIT 1`,
      )
      .get();
    if (!row) return;

    // unique partial index บน status='leased' กันไม่ให้ claim ซ้อนกับงานอื่นของ service เดียวกัน
    // (ถ้าชน จะ throw แล้ว transaction rollback — รอบหน้าค่อยลองใหม่)
    const updated = db
      .query(
        `UPDATE service_jobs
            SET status = 'leased', lease_owner = ?, lease_expires_at = ?,
                attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(workerId, now + leaseMs, now, row.id);

    if ((updated.changes ?? 0) === 0) return;

    claimed = {
      id: row.id,
      serviceId: row.service_id,
      type: row.type as ServiceJobType,
      attempts: row.attempts + 1,
      maxAttempts: row.max_attempts,
    };
  })();

  return claimed;
}

export function renewServiceLease(
  db: Database,
  jobId: string,
  workerId: string,
  leaseMs = DEPLOY_QUEUE.leaseMs,
): boolean {
  const result = db
    .query(
      `UPDATE service_jobs SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND lease_owner = ? AND status = 'leased'`,
    )
    .run(Date.now() + leaseMs, Date.now(), jobId, workerId);
  return (result.changes ?? 0) > 0;
}

export function completeServiceJob(db: Database, jobId: string): void {
  db.query(
    "UPDATE service_jobs SET status = 'done', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
  ).run(Date.now(), jobId);
}

export function failServiceJob(db: Database, jobId: string, message: string): void {
  db.query(
    `UPDATE service_jobs
        SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
            failure_message = ?, updated_at = ?
      WHERE id = ?`,
  ).run(message.slice(0, 500), Date.now(), jobId);
}

/**
 * ลบงานที่จบแล้วและเก่ากว่า cutoff — ตารางนี้โตเรื่อย ๆ ถ้าไม่กวาด
 * เก็บงานที่ failed ไว้นานกว่าเพื่อให้ผู้ใช้ยังเห็นสาเหตุ
 */
export function pruneServiceJobs(db: Database, doneOlderThanMs: number): number {
  const result = db
    .query("DELETE FROM service_jobs WHERE status = 'done' AND updated_at < ?")
    .run(Date.now() - doneOlderThanMs);
  return result.changes ?? 0;
}
