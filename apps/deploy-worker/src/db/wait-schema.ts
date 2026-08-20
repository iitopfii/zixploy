/**
 * รอ control-api migrate database ให้ครบก่อน worker เริ่มทำงาน — worker ไม่ migrate เอง (ADR-0002)
 *
 * ทุก deploy ที่มี migration ใหม่ worker กับ control-api ขึ้นพร้อมกัน worker จึงเห็น schema เก่า
 * อยู่ครู่หนึ่งเป็นเรื่องปกติ ไม่ใช่ความผิดปกติ — เดิม worker exit ทันทีแล้วรอ Docker restart ให้
 * ผลคือมี error log + restart หนึ่งครั้งทุกครั้งที่ deploy ทั้งที่ระบบทำงานถูกต้อง
 *
 * ยัง fail closed เหมือนเดิม: ระหว่างรอ worker ไม่แตะ DB เลย และถ้าหมดเวลาแล้ว schema ยังไม่ครบ
 * (control-api ไม่ได้เปิด / deploy ไม่ตรงกัน / migration พัง) ผู้เรียกต้อง exit ตามเดิม
 */

import type { Database } from "bun:sqlite";
import { assertMigrated, type Migration } from "@zixploy/db";

export interface WaitSchemaOptions {
  /** หมดเวลาแล้วยังไม่ครบ = ผิดปกติจริง ไม่ใช่แค่จังหวะ deploy */
  timeoutMs?: number;
  pollMs?: number;
  /** เรียกครั้งเดียวตอนเริ่มรอ (ไม่ spam ทุกรอบ poll) */
  onWait?: (reason: string) => void;
  /** เรียกเมื่อ schema ครบหลังจากที่เคยรอ — deploy ที่ไม่มี migration ใหม่จะเงียบสนิท */
  onReady?: (waitedMs: number) => void;
  /** ฉีดในเทสต์เพื่อไม่ต้องรอเวลาจริง */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** คืน null เมื่อ schema ครบ · คืนข้อความสาเหตุล่าสุดเมื่อหมดเวลา (ผู้เรียกตัดสินใจ exit เอง) */
export async function waitForSchema(
  db: Database,
  migrations: Migration[],
  options: WaitSchemaOptions = {},
): Promise<string | null> {
  const {
    timeoutMs = 60_000,
    pollMs = 500,
    onWait,
    onReady,
    sleep = (ms: number) => Bun.sleep(ms),
    now = () => Date.now(),
  } = options;

  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let waiting = false;

  while (true) {
    let reason: string | null = null;
    try {
      assertMigrated(db, migrations);
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }

    if (reason === null) {
      if (waiting) onReady?.(now() - startedAt);
      return null;
    }

    // เช็คก่อน sleep เสมอ — timeoutMs=0 ต้องคืนทันทีโดยไม่รอ (พฤติกรรม fail-fast เดิม)
    if (now() >= deadline) return reason;

    if (!waiting) {
      waiting = true;
      onWait?.(reason);
    }
    await sleep(pollMs);
  }
}
