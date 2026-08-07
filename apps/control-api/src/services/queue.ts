/**
 * Service job enqueue — Phase 10 M2
 *
 * ADR-0002: **เฉพาะ control-api เท่านั้นที่ INSERT service_jobs** worker แค่ claim/update
 * งานที่มีอยู่ ไม่เคยตัดสินใจเองว่า "ควรมีงานนี้"
 *
 * unique partial index บน (service_id) WHERE status='pending'/'leased' บังคับว่า
 * หนึ่ง service มีงานค้างได้ครั้งละหนึ่งอย่าง — สั่ง restart ระหว่าง provision ยังไม่จบไม่ได้
 * (กัน operation ซ้อนกันบน container เดียว ซึ่งทำให้ container/volume พังได้)
 */

import type { Database } from "bun:sqlite";
import { AppError, ulid } from "@zixploy/shared";

export type ServiceJobType = "provision" | "start" | "stop" | "restart" | "destroy";

export interface EnqueueResult {
  jobId: string;
}

/**
 * สร้างงานใหม่ให้ worker — ล้มด้วย SERVICE_BUSY ถ้ามีงานค้างอยู่แล้ว
 *
 * ไม่ coalesce งานซ้ำเหมือน deploy queue โดยตั้งใจ: "restart แล้ว restart อีก" ผู้ใช้
 * ตั้งใจให้เกิดสองครั้งจริง ๆ ต่างจาก push ซ้อนที่ build ครั้งเดียวก็พอ
 */
export function enqueueServiceJob(
  db: Database,
  serviceId: string,
  type: ServiceJobType,
  payload: Record<string, unknown> = {},
): EnqueueResult {
  const now = Date.now();
  const jobId = ulid();

  try {
    db.query(
      `INSERT INTO service_jobs (id, service_id, type, status, payload, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(jobId, serviceId, type, JSON.stringify(payload), now, now);
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      throw new AppError("SERVICE_BUSY", "service นี้มีงานที่กำลังดำเนินการอยู่ — รอให้เสร็จก่อนสั่งงานใหม่");
    }
    throw err;
  }

  return { jobId };
}

/** มีงานค้างอยู่ไหม — UI ใช้ปิดปุ่มระหว่างที่ worker กำลังทำงาน */
export function hasPendingJob(db: Database, serviceId: string): boolean {
  const row = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM service_jobs WHERE service_id = ? AND status IN ('pending', 'leased') LIMIT 1",
    )
    .get(serviceId);
  return row != null;
}
