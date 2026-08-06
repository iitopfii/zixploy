/**
 * Runtime log poller — Phase 6 M4
 *
 * Background loop ที่รันคู่กับ heartbeatLoop + jobLoop ใน index.ts
 *
 * ทุก LOG_SETTINGS.runtimePollMs:
 * 1. หา active container per project (query deployments + projects)
 * 2. รัน `docker logs --since <last_poll>` ผ่าน DockerCliClient.fetchLogs()
 * 3. INSERT บรรทัดใหม่ลง runtime_logs
 * 4. ตัด ring buffer: DELETE rows เกิน RUNTIME_LOG_RING_SIZE ต่อ project
 *
 * Architecture constraints:
 * - Worker เดียวเท่านั้นที่เขียน runtime_logs (เหมือน build_logs)
 * - control-api อ่านจาก SQLite — ไม่มี Docker socket access (ADR-0002)
 * - รับ signal เพื่อ graceful shutdown (เดียวกับ heartbeatLoop)
 *
 * Secret redaction: runtime logs ไม่ผ่าน redact pipeline ในตอนนี้ (phase doc: MVP)
 * — อนาคตใส่ redactFn ก่อน INSERT ได้โดยไม่ต้องเปลี่ยน schema
 */

import type { Database } from "bun:sqlite";
import { LOG_SETTINGS, ulid } from "@zixploy/shared";
import type { DockerCliClient } from "../docker/cli-client";

interface ActiveContainer {
  projectId: string;
  containerId: string;
}

/** หา container ที่ active ในแต่ละ project (deployment status = succeeded + มี container_id) */
function findActiveContainers(db: Database): ActiveContainer[] {
  return db
    .query<{ project_id: string; container_id: string }, []>(
      `SELECT DISTINCT d.project_id, d.container_id
       FROM deployments d
       INNER JOIN projects p ON p.id = d.project_id AND p.archived_at IS NULL
       WHERE d.status = 'succeeded'
         AND d.container_id IS NOT NULL
         AND d.id = (
           SELECT id FROM deployments d2
           WHERE d2.project_id = d.project_id AND d2.status = 'succeeded' AND d2.container_id IS NOT NULL
           ORDER BY d2.finished_at DESC LIMIT 1
         )`,
    )
    .all()
    .map((r) => ({ projectId: r.project_id, containerId: r.container_id }));
}

/** INSERT บรรทัด log ใหม่ + รักษา ring buffer ให้ไม่เกิน RUNTIME_LOG_RING_SIZE */
function insertRuntimeLogs(
  db: Database,
  projectId: string,
  containerId: string,
  lines: Array<{ stream: "stdout" | "stderr"; line: string; loggedAt: number }>,
): void {
  if (lines.length === 0) return;

  // หา seq ล่าสุดของ project
  const existing = db
    .query<{ max_seq: number | null }, [string]>(
      "SELECT MAX(seq) as max_seq FROM runtime_logs WHERE project_id = ?",
    )
    .get(projectId);
  let seq = (existing?.max_seq ?? 0) + 1;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO runtime_logs
       (id, project_id, container_id, seq, stream, line, logged_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const now = Date.now();
  for (const entry of lines) {
    try {
      insert.run(
        ulid(),
        projectId,
        containerId,
        seq,
        entry.stream,
        entry.line,
        entry.loggedAt,
        now,
      );
      seq++;
    } catch {
      // ignore individual write failures
    }
  }

  // Ring buffer: DELETE rows เก่าเกิน RUNTIME_LOG_RING_SIZE
  const ringSize = LOG_SETTINGS.runtimeRingSize;
  db.query(
    `DELETE FROM runtime_logs
     WHERE project_id = ? AND seq <= (
       SELECT seq FROM runtime_logs
       WHERE project_id = ?
       ORDER BY seq DESC
       LIMIT 1 OFFSET ?
     )`,
  ).run(projectId, projectId, ringSize - 1);
}

/**
 * Background loop — รัน parallel กับ heartbeatLoop + jobLoop
 *
 * @param db      SQLite connection (เดียวกับที่ worker ใช้ทั้งหมด)
 * @param docker  DockerCliClient (เดียวกับที่ใช้ใน pipeline)
 * @param signal  AbortSignal จาก global AbortController ของ worker
 */
export async function runtimeLogLoop(
  db: Database,
  docker: DockerCliClient,
  signal: AbortSignal,
): Promise<void> {
  // lastPollMs ต่อ containerId — incremental pull
  const lastPoll = new Map<string, number>();

  while (!signal.aborted) {
    try {
      const activeContainers = findActiveContainers(db);

      for (const { projectId, containerId } of activeContainers) {
        if (signal.aborted) break;
        try {
          const sinceMs = lastPoll.get(containerId) ?? 0;
          const lines = await docker.fetchLogs(containerId, sinceMs);
          if (lines.length > 0) {
            insertRuntimeLogs(db, projectId, containerId, lines);
            // อัป lastPoll เป็น timestamp ล่าสุดที่ได้รับ + 1ms เพื่อไม่ดึงซ้ำ
            const maxLoggedAt = Math.max(...lines.map((l) => l.loggedAt));
            lastPoll.set(containerId, maxLoggedAt + 1);
          } else {
            // ยังมี container แต่ไม่มี log ใหม่ — อัป lastPoll เป็นตอนนี้
            if (!lastPoll.has(containerId)) {
              lastPoll.set(containerId, Date.now());
            }
          }
        } catch {
          // container อาจหายไประหว่าง poll — ignore ข้าม container นี้รอบนี้
        }
      }

      // ลบ container ที่ไม่ active ออกจาก lastPoll กัน memory leak
      const activeIds = new Set(activeContainers.map((c) => c.containerId));
      for (const key of lastPoll.keys()) {
        if (!activeIds.has(key)) lastPoll.delete(key);
      }
    } catch {
      // DB error หรืออื่นๆ — รอแล้วลองใหม่รอบหน้า ไม่ crash worker
    }

    // รอ poll interval ถัดไป (ออก loop ทันทีเมื่อ signal aborted)
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, LOG_SETTINGS.runtimePollMs);
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
