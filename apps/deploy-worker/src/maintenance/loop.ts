/**
 * Maintenance job loop — Phase 11
 *
 * claim งาน prune ที่ control-api สร้างไว้ แล้วรัน docker prune จริง (ADR-0002)
 * fail-soft: งานที่พังบันทึกสาเหตุลง DB ไม่หยุด loop
 */

import type { Database } from "bun:sqlite";
import { MAINTENANCE } from "@zixploy/shared";
import { runPrune } from "./prune";
import { startSelfUpdate } from "./self-update";

interface JobRow {
  id: string;
  type: string;
  /** เฉพาะ self_update — tag ที่จะอัปไป */
  target_version: string | null;
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
 * คืนงานที่ lease หมดอายุกลับเป็น failed (ไม่ retry)
 *
 * ต่างจาก deploy/service job ที่ retry ได้ — prune ที่ค้างแปลว่า docker ไม่ตอบสนอง
 * ลองใหม่อัตโนมัติจะไปเพิ่มภาระให้ daemon ที่กำลังมีปัญหา ผู้ใช้กดใหม่เองดีกว่า
 */
function recoverStale(db: Database, now: number): void {
  db.query(
    `UPDATE maintenance_jobs
        SET status = 'failed',
            failure_message = 'worker หยุดทำงานระหว่างล้าง cache — กดล้างใหม่ได้',
            lease_owner = NULL, lease_expires_at = NULL,
            updated_at = ?, finished_at = ?
      WHERE status = 'leased' AND lease_expires_at < ?`,
  ).run(now, now, now);
}

function claimNext(db: Database, workerId: string, now: number): JobRow | null {
  recoverStale(db, now);

  let claimed: JobRow | null = null;
  db.transaction(() => {
    const row = db
      .query<JobRow, []>(
        "SELECT id, type, target_version FROM maintenance_jobs WHERE status = 'pending' ORDER BY created_at LIMIT 1",
      )
      .get();
    if (!row) return;

    const updated = db
      .query(
        `UPDATE maintenance_jobs
            SET status = 'leased', lease_owner = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(workerId, now + MAINTENANCE.jobTimeoutMs, now, row.id);

    if ((updated.changes ?? 0) > 0) claimed = row;
  })();

  return claimed;
}

export async function maintenanceLoop(
  db: Database,
  workerId: string,
  signal: AbortSignal,
  onLog: (line: string) => void = () => {},
): Promise<void> {
  while (!signal.aborted) {
    let job: JobRow | null = null;
    try {
      job = claimNext(db, workerId, Date.now());
    } catch {
      // DB busy — รอรอบหน้า
    }

    if (!job) {
      await sleep(MAINTENANCE.pollIntervalMs, signal);
      continue;
    }

    const claimed = job;
    onLog(`maintenance job claimed: ${claimed.type}`);

    try {
      if (claimed.type === "self_update") {
        if (!claimed.target_version) {
          throw new Error("งาน self_update ไม่มี target_version");
        }
        /**
         * mark done ทันทีที่ spawn updater สำเร็จ — ไม่รอให้อัปเดตเสร็จ
         *
         * เพราะ updater จะ recreate worker ตัวนี้ทิ้ง ถ้ารอผลก่อนเขียน DB จะไม่มีโอกาส
         * ได้เขียนเลย งานค้าง leased ตลอดไปแล้ว recoverStale จะ mark เป็น failed
         * ทั้งที่อัปเดตสำเร็จ — เขียนก่อนจึงเป็นทางเดียวที่บันทึกผลได้จริง
         */
        const result = await startSelfUpdate(claimed.target_version);
        db.query(
          `UPDATE maintenance_jobs
              SET status = 'done', summary = ?,
                  lease_owner = NULL, lease_expires_at = NULL,
                  updated_at = ?, finished_at = ?
            WHERE id = ?`,
        ).run(result.summary, Date.now(), Date.now(), claimed.id);
        onLog(`self-update started: ${claimed.target_version}`);
        continue;
      }

      const result = await runPrune(claimed.type as Parameters<typeof runPrune>[0]);
      db.query(
        `UPDATE maintenance_jobs
            SET status = 'done', reclaimed_bytes = ?, summary = ?,
                lease_owner = NULL, lease_expires_at = NULL,
                updated_at = ?, finished_at = ?
          WHERE id = ?`,
      ).run(result.reclaimedBytes, result.summary, Date.now(), Date.now(), claimed.id);
      onLog(`maintenance done: ${result.summary}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.query(
        `UPDATE maintenance_jobs
            SET status = 'failed', failure_message = ?,
                lease_owner = NULL, lease_expires_at = NULL,
                updated_at = ?, finished_at = ?
          WHERE id = ?`,
      ).run(message.slice(0, 500), Date.now(), Date.now(), claimed.id);
      onLog(`maintenance failed: ${message}`);
    }
  }
}
