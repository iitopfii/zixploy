/**
 * Build log writer — persist build output ลง build_logs (docs/phase-06-logs.md M2)
 *
 * Worker เป็นผู้เดียวที่ write; control-api อ่านจาก SQLite โดยตรง (ไม่มี IPC/RPC)
 *
 * Secret redaction ทำที่ caller ก่อนส่งเข้า log() — ดู pipeline/build.ts (safeLog wrapper)
 * writer นี้ไม่ redact เพิ่มเติม (single responsibility)
 *
 * seq เริ่มต้นจาก MAX(seq)+1 ของ deployment นั้น (safe: worker process เดียว per deployment)
 * write failure ถูก swallow เพื่อไม่ให้ crash pipeline — graceful degradation
 */

import type { Database } from "bun:sqlite";
import { ulid } from "@zixploy/shared";

export type LogStream = "stdout" | "stderr";

export interface BuildLogger {
  /** เขียนบรรทัด log หนึ่งบรรทัด — seq เพิ่มอัตโนมัติ */
  log(line: string, stream?: LogStream): void;
}

/**
 * สร้าง BuildLogger สำหรับ deployment หนึ่ง
 * @param db  SQLite connection (same file ที่ control-api อ่าน — WAL mode)
 * @param deploymentId  ULID ของ deployment ที่ log นี้ผูกกับ
 */
export function makeBuildLogger(db: Database, deploymentId: string): BuildLogger {
  // เริ่ม seq ต่อจาก row ล่าสุดของ deployment (idempotent: worker restart ปลอดภัย)
  const existing = db
    .query<{ max_seq: number | null }, [string]>(
      "SELECT MAX(seq) as max_seq FROM build_logs WHERE deployment_id = ?",
    )
    .get(deploymentId);
  let seq = (existing?.max_seq ?? 0) + 1;

  const insert = db.prepare(
    `INSERT INTO build_logs (id, deployment_id, seq, stream, line, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  return {
    log(line, stream = "stdout") {
      try {
        insert.run(ulid(), deploymentId, seq, stream, line, Date.now());
        seq++;
      } catch {
        // ไม่ crash pipeline ถ้า log write ล้มเหลว (disk full, lock timeout ฯลฯ)
        // pipeline ยังดำเนินต่อได้ — log แค่หาย ไม่ใช่ deploy พัง
      }
    },
  };
}
