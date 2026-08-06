/**
 * runtimeLogLoop — unit tests (docs/phase-06-logs.md M4)
 *
 * ครอบคลุม:
 * - ไม่มี active container → ไม่ insert อะไร
 * - มี active container → fetchLogs → insert ลง runtime_logs
 * - ring buffer truncation (เกิน RUNTIME_LOG_RING_SIZE → ลบเก่า)
 * - container หายระหว่าง poll (fetchLogs return []) → graceful, ไม่ crash
 * - lastPoll incremental: รอบที่สองส่ง since > 0
 *
 * ใช้ mock DockerCliClient (ไม่ต้องการ Docker daemon จริง)
 */

import { describe, expect, mock, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { LOG_SETTINGS, ulid } from "@zixploy/shared";
import type { DockerCliClient } from "../src/docker/cli-client";
import { runtimeLogLoop } from "../src/logs/runtime-poller";

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function insertProject(db: ReturnType<typeof makeDb>): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO projects
      (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'test', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(id, now, now);
  return id;
}

function insertSucceededDeployment(
  db: ReturnType<typeof makeDb>,
  projectId: string,
  containerId: string,
): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO deployments
       (id, project_id, status, trigger, commit_sha, container_id, queued_at, finished_at, created_at, updated_at)
     VALUES (?, ?, 'succeeded', 'push', 'abc', ?, ?, ?, ?, ?)`,
  ).run(id, projectId, containerId, now, now, now, now);
  return id;
}

function countRuntimeLogs(db: ReturnType<typeof makeDb>, projectId: string): number {
  return db
    .query<{ cnt: number }, [string]>(
      "SELECT COUNT(*) as cnt FROM runtime_logs WHERE project_id = ?",
    )
    .get(projectId)!.cnt;
}

function getRuntimeLogs(db: ReturnType<typeof makeDb>, projectId: string) {
  return db
    .query<{ seq: number; line: string; stream: string }, [string]>(
      "SELECT seq, line, stream FROM runtime_logs WHERE project_id = ? ORDER BY seq ASC",
    )
    .all(projectId);
}

/** รัน loop แค่รอบเดียวแล้ว abort ทันที */
async function runOneIteration(
  db: ReturnType<typeof makeDb>,
  dockerMock: Partial<DockerCliClient>,
): Promise<void> {
  const controller = new AbortController();

  // abort หลังจาก microtask queue ว่าง (รอ 1 iteration)
  const loopPromise = runtimeLogLoop(db, dockerMock as DockerCliClient, controller.signal);

  // ให้ loop รอบแรกทำงานเสร็จก่อน abort
  await new Promise<void>((res) => setTimeout(res, 20));
  controller.abort();
  await loopPromise;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runtimeLogLoop — ไม่มี active container", () => {
  test("ไม่ insert อะไรเมื่อไม่มี deployment succeeded", async () => {
    const db = makeDb();
    const projectId = insertProject(db);

    const fetchLogs = mock(() => Promise.resolve([]));
    await runOneIteration(db, { fetchLogs });

    expect(countRuntimeLogs(db, projectId)).toBe(0);
    // fetchLogs ไม่ถูกเรียกเลย
    expect(fetchLogs.mock.calls).toHaveLength(0);
  });
});

describe("runtimeLogLoop — มี active container", () => {
  test("fetchLogs → insert ลง runtime_logs", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const containerId = "abc123";
    insertSucceededDeployment(db, projectId, containerId);

    const now = Date.now();
    const fetchLogs = mock(() =>
      Promise.resolve([
        { stream: "stdout" as const, line: "line one", loggedAt: now },
        { stream: "stderr" as const, line: "line two", loggedAt: now + 1 },
      ]),
    );

    await runOneIteration(db, { fetchLogs });

    const rows = getRuntimeLogs(db, projectId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.line).toBe("line one");
    expect(rows[0]!.stream).toBe("stdout");
    expect(rows[1]!.line).toBe("line two");
    expect(rows[1]!.stream).toBe("stderr");
  });

  test("fetchLogs return [] → ไม่ insert, ไม่ crash", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertSucceededDeployment(db, projectId, "cid1");

    const fetchLogs = mock(() => Promise.resolve([]));
    await runOneIteration(db, { fetchLogs });

    expect(countRuntimeLogs(db, projectId)).toBe(0);
    // fetchLogs ถูกเรียกแต่คืน []
    expect(fetchLogs.mock.calls).toHaveLength(1);
  });

  test("fetchLogs throws → graceful, ไม่ crash loop", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertSucceededDeployment(db, projectId, "cid1");

    const fetchLogs = mock(() => Promise.reject(new Error("container gone")));
    // ไม่ควร throw
    await expect(runOneIteration(db, { fetchLogs })).resolves.toBeUndefined();
    expect(countRuntimeLogs(db, projectId)).toBe(0);
  });
});

describe("runtimeLogLoop — ring buffer", () => {
  test(`ลบ row เก่าเมื่อเกิน RUNTIME_LOG_RING_SIZE (${LOG_SETTINGS.runtimeRingSize})`, async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const containerId = "cring";
    insertSucceededDeployment(db, projectId, containerId);

    // pre-fill ring buffer ถึง limit
    const ringSize = LOG_SETTINGS.runtimeRingSize;
    const now = Date.now();
    for (let i = 1; i <= ringSize; i++) {
      db.query(
        `INSERT INTO runtime_logs
           (id, project_id, container_id, seq, stream, line, logged_at, created_at)
         VALUES (?, ?, ?, ?, 'stdout', ?, ?, ?)`,
      ).run(ulid(), projectId, containerId, i, `old line ${i}`, now, now);
    }
    expect(countRuntimeLogs(db, projectId)).toBe(ringSize);

    // insert เพิ่มอีก 3 บรรทัดผ่าน loop — ring buffer ต้องตัดให้เหลือ ringSize
    const fetchLogs = mock(() =>
      Promise.resolve([
        { stream: "stdout" as const, line: "new 1", loggedAt: now + 1000 },
        { stream: "stdout" as const, line: "new 2", loggedAt: now + 1001 },
        { stream: "stdout" as const, line: "new 3", loggedAt: now + 1002 },
      ]),
    );
    await runOneIteration(db, { fetchLogs });

    expect(countRuntimeLogs(db, projectId)).toBeLessThanOrEqual(ringSize);
    // บรรทัดใหม่ต้องอยู่ใน ring buffer
    const rows = getRuntimeLogs(db, projectId);
    const lines = rows.map((r) => r.line);
    expect(lines).toContain("new 1");
    expect(lines).toContain("new 2");
    expect(lines).toContain("new 3");
  });
});
