/**
 * serviceLogLoop — unit tests (Phase 15, มาแทน runtime-poller.test.ts ฝั่ง service)
 *
 * ครอบคลุมเหมือน runtimeLogLoop ทุกอย่างเพราะ copy โครงมาตรง ๆ ต่างแค่แหล่งข้อมูล:
 * - ไม่มี service ที่มี container_id → ไม่ insert อะไร
 * - มี service → fetchLogs → insert ลง service_logs
 * - ring buffer truncation
 * - container หายระหว่าง poll → graceful, ไม่ crash
 * - service ที่ status='deleting' ไม่ถูกตาม (กัน poll container ที่กำลังถูกทำลาย)
 */

import { describe, expect, mock, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { LOG_SETTINGS, ulid } from "@zixploy/shared";
import type { DockerCliClient } from "../src/docker/cli-client";
import { serviceLogLoop } from "../src/logs/service-poller";

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function insertService(
  db: ReturnType<typeof makeDb>,
  opts: { containerId?: string | null; status?: string } = {},
): string {
  const id = ulid();
  const now = Date.now();
  // name/volume_name ต้อง unique ทั้งตาราง — อิง id กันชนกันเมื่อ insert หลายตัวในเทสต์เดียว
  db.query(
    `INSERT INTO services
      (id, name, type, version, image, status, container_id, volume_name,
       username, database_name, internal_port, created_at, updated_at)
     VALUES (?, ?, 'postgres', '16', 'postgres:16', ?, ?, ?,
             'app', 'app', 5432, ?, ?)`,
  ).run(
    id,
    `db-${id.toLowerCase()}`,
    opts.status ?? "running",
    opts.containerId ?? "svc-container-1",
    `zxsvcvol-${id.toLowerCase()}`,
    now,
    now,
  );
  return id;
}

function countServiceLogs(db: ReturnType<typeof makeDb>, serviceId: string): number {
  return db
    .query<{ cnt: number }, [string]>(
      "SELECT COUNT(*) as cnt FROM service_logs WHERE service_id = ?",
    )
    .get(serviceId)!.cnt;
}

function getServiceLogs(db: ReturnType<typeof makeDb>, serviceId: string) {
  return db
    .query<{ seq: number; line: string; stream: string }, [string]>(
      "SELECT seq, line, stream FROM service_logs WHERE service_id = ? ORDER BY seq ASC",
    )
    .all(serviceId);
}

/** รัน loop แค่รอบเดียวแล้ว abort ทันที */
async function runOneIteration(
  db: ReturnType<typeof makeDb>,
  dockerMock: Partial<DockerCliClient>,
): Promise<void> {
  const controller = new AbortController();
  const loopPromise = serviceLogLoop(db, dockerMock as DockerCliClient, controller.signal);
  await new Promise<void>((res) => setTimeout(res, 20));
  controller.abort();
  await loopPromise;
}

// ---------------------------------------------------------------------------

describe("serviceLogLoop — ไม่มี service ที่มี container", () => {
  test("ไม่ insert อะไรเมื่อไม่มี service เลย", async () => {
    const db = makeDb();
    const fetchLogs = mock(() => Promise.resolve([]));
    await runOneIteration(db, { fetchLogs });
    expect(fetchLogs.mock.calls).toHaveLength(0);
  });

  test("service ที่ status='deleting' ไม่ถูกตาม — container กำลังถูกทำลายอยู่", async () => {
    const db = makeDb();
    const serviceId = insertService(db, { status: "deleting" });
    const fetchLogs = mock(() => Promise.resolve([]));
    await runOneIteration(db, { fetchLogs });

    expect(fetchLogs.mock.calls).toHaveLength(0);
    expect(countServiceLogs(db, serviceId)).toBe(0);
  });
});

describe("serviceLogLoop — มี service ที่มี container", () => {
  test("fetchLogs → insert ลง service_logs", async () => {
    const db = makeDb();
    const serviceId = insertService(db, { containerId: "abc123" });

    const now = Date.now();
    const fetchLogs = mock(() =>
      Promise.resolve([
        {
          stream: "stdout" as const,
          line: "database system is ready to accept connections",
          loggedAt: now,
        },
        { stream: "stderr" as const, line: "some warning", loggedAt: now + 1 },
      ]),
    );

    await runOneIteration(db, { fetchLogs });

    const rows = getServiceLogs(db, serviceId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.line).toBe("database system is ready to accept connections");
    expect(rows[0]!.stream).toBe("stdout");
    expect(rows[1]!.stream).toBe("stderr");
  });

  test("fetchLogs return [] → ไม่ insert, ไม่ crash", async () => {
    const db = makeDb();
    const serviceId = insertService(db);
    const fetchLogs = mock(() => Promise.resolve([]));
    await runOneIteration(db, { fetchLogs });

    expect(countServiceLogs(db, serviceId)).toBe(0);
    expect(fetchLogs.mock.calls).toHaveLength(1);
  });

  test("fetchLogs throws (container หายระหว่าง poll) → graceful, ไม่ crash loop", async () => {
    const db = makeDb();
    insertService(db);
    const fetchLogs = mock(() => Promise.reject(new Error("no such container")));
    await expect(runOneIteration(db, { fetchLogs })).resolves.toBeUndefined();
  });

  test("service หลายตัว → poll ทุกตัวแยกกัน", async () => {
    const db = makeDb();
    const s1 = insertService(db, { containerId: "c1" });
    const s2 = insertService(db, { containerId: "c2" });

    const fetchLogs = mock((containerId: string) =>
      Promise.resolve([
        { stream: "stdout" as const, line: `hello from ${containerId}`, loggedAt: Date.now() },
      ]),
    );
    await runOneIteration(db, { fetchLogs: fetchLogs as unknown as DockerCliClient["fetchLogs"] });

    expect(getServiceLogs(db, s1)[0]?.line).toBe("hello from c1");
    expect(getServiceLogs(db, s2)[0]?.line).toBe("hello from c2");
  });
});

describe("serviceLogLoop — ring buffer", () => {
  test(`ลบ row เก่าเมื่อเกิน RUNTIME_LOG_RING_SIZE (${LOG_SETTINGS.runtimeRingSize})`, async () => {
    const db = makeDb();
    const serviceId = insertService(db, { containerId: "cring" });

    const ringSize = LOG_SETTINGS.runtimeRingSize;
    const now = Date.now();
    for (let i = 1; i <= ringSize; i++) {
      db.query(
        `INSERT INTO service_logs
           (id, service_id, container_id, seq, stream, line, logged_at, created_at)
         VALUES (?, ?, 'cring', ?, 'stdout', ?, ?, ?)`,
      ).run(ulid(), serviceId, i, `old line ${i}`, now, now);
    }
    expect(countServiceLogs(db, serviceId)).toBe(ringSize);

    const fetchLogs = mock(() =>
      Promise.resolve([
        { stream: "stdout" as const, line: "new 1", loggedAt: now + 1000 },
        { stream: "stdout" as const, line: "new 2", loggedAt: now + 1001 },
      ]),
    );
    await runOneIteration(db, { fetchLogs });

    expect(countServiceLogs(db, serviceId)).toBeLessThanOrEqual(ringSize);
    const lines = getServiceLogs(db, serviceId).map((r) => r.line);
    expect(lines).toContain("new 1");
    expect(lines).toContain("new 2");
  });
});
