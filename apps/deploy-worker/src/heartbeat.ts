import type { Database } from "bun:sqlite";
import { WORKER_HEARTBEAT } from "@zixploy/shared";

/** เขียน heartbeat หนึ่งครั้ง (upsert) — API อ่านตารางนี้เพื่อรายงาน worker readiness */
export function beat(db: Database, workerId: string, startedAt: number): void {
  db.query(
    `INSERT INTO worker_heartbeats (worker_id, started_at, last_beat_at)
     VALUES (?, ?, ?)
     ON CONFLICT(worker_id) DO UPDATE SET last_beat_at = excluded.last_beat_at`,
  ).run(workerId, startedAt, Date.now());
}

/** Heartbeat loop — หยุดเมื่อ signal ถูก abort */
export async function heartbeatLoop(
  db: Database,
  workerId: string,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = Date.now();
  while (!signal.aborted) {
    beat(db, workerId, startedAt);
    await sleep(WORKER_HEARTBEAT.intervalMs, signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
