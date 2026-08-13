/**
 * Service log poller — Phase 15
 *
 * โครงเดียวกับ runtime-poller.ts (log ของ project) แต่ตามหลัง container ของ managed service
 * (database) แทน — แยกไฟล์เพราะเขียนคนละตาราง (service_logs) และหา container คนละวิธี
 *
 * ทุก LOG_SETTINGS.runtimePollMs:
 * 1. หา service ที่มี container_id (running/starting — ไม่รวมที่ถูกลบไปแล้ว)
 * 2. `docker logs --since <last_poll>` ผ่าน DockerCliClient.fetchLogs()
 * 3. INSERT บรรทัดใหม่ลง service_logs
 * 4. ตัด ring buffer ต่อ service
 *
 * Architecture: worker เท่านั้นที่เขียน (ADR-0002) — control-api อ่านจาก SQLite ไม่แตะ Docker
 *
 * หมายเหตุความปลอดภัย: log ของ database มักมีข้อความ init ที่ **ไม่** มีรหัสผ่าน (template ส่ง
 * password ผ่าน env ไม่ใช่ argv — ดู services/provision.ts) แต่ก็ยังเป็นข้อมูลที่ต้อง auth ถึงอ่านได้
 * เหมือน runtime log ของ project (routes/logs.ts บังคับ requireAuthenticated)
 */

import type { Database } from "bun:sqlite";
import { LOG_SETTINGS, ulid } from "@zixploy/shared";
import type { DockerCliClient } from "../docker/cli-client";

interface ActiveService {
  serviceId: string;
  containerId: string;
}

/**
 * service ที่มี container ให้ตาม — เอาทุกตัวที่ยังมี container_id และไม่ได้กำลังถูกลบ
 * (รวม 'stopped' ด้วย: container ที่หยุดแล้วยังมี log เก่าให้ดูว่าทำไมถึงหยุด)
 */
function findActiveServices(db: Database): ActiveService[] {
  return db
    .query<{ id: string; container_id: string }, []>(
      `SELECT id, container_id FROM services
       WHERE container_id IS NOT NULL AND status <> 'deleting'`,
    )
    .all()
    .map((r) => ({ serviceId: r.id, containerId: r.container_id }));
}

/** INSERT บรรทัดใหม่ + รักษา ring buffer ต่อ service */
function insertServiceLogs(
  db: Database,
  serviceId: string,
  containerId: string,
  lines: Array<{ stream: "stdout" | "stderr"; line: string; loggedAt: number }>,
): void {
  if (lines.length === 0) return;

  const existing = db
    .query<{ max_seq: number | null }, [string]>(
      "SELECT MAX(seq) as max_seq FROM service_logs WHERE service_id = ?",
    )
    .get(serviceId);
  let seq = (existing?.max_seq ?? 0) + 1;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO service_logs
       (id, service_id, container_id, seq, stream, line, logged_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const now = Date.now();
  for (const entry of lines) {
    try {
      insert.run(
        ulid(),
        serviceId,
        containerId,
        seq,
        entry.stream,
        entry.line,
        entry.loggedAt,
        now,
      );
      seq++;
    } catch {
      // แถวเดียวเขียนไม่ได้ไม่ควรทำให้ทั้งรอบล้ม
    }
  }

  const ringSize = LOG_SETTINGS.runtimeRingSize;
  db.query(
    `DELETE FROM service_logs
     WHERE service_id = ? AND seq <= (
       SELECT seq FROM service_logs
       WHERE service_id = ?
       ORDER BY seq DESC
       LIMIT 1 OFFSET ?
     )`,
  ).run(serviceId, serviceId, ringSize - 1);
}

/** Background loop — รัน parallel กับ runtimeLogLoop/heartbeatLoop/jobLoop */
export async function serviceLogLoop(
  db: Database,
  docker: DockerCliClient,
  signal: AbortSignal,
): Promise<void> {
  const lastPoll = new Map<string, number>();

  while (!signal.aborted) {
    try {
      const services = findActiveServices(db);

      for (const { serviceId, containerId } of services) {
        if (signal.aborted) break;
        try {
          const sinceMs = lastPoll.get(containerId) ?? 0;
          const lines = await docker.fetchLogs(containerId, sinceMs);
          if (lines.length > 0) {
            insertServiceLogs(db, serviceId, containerId, lines);
            const maxLoggedAt = Math.max(...lines.map((l) => l.loggedAt));
            lastPoll.set(containerId, maxLoggedAt + 1);
          } else if (!lastPoll.has(containerId)) {
            lastPoll.set(containerId, Date.now());
          }
        } catch {
          // container หายไประหว่าง poll (ถูกลบ/recreate) — ข้ามรอบนี้
        }
      }

      const activeIds = new Set(services.map((s) => s.containerId));
      for (const key of lastPoll.keys()) {
        if (!activeIds.has(key)) lastPoll.delete(key);
      }
    } catch {
      // DB error — รอรอบหน้า ไม่ crash worker
    }

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
