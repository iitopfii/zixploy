/**
 * General state reconciler tests — Phase 8 M2
 *
 * ครอบคลุม:
 * - project running + container missing → degraded_at ถูกตั้ง, ไม่ตั้งซ้ำ
 * - project running + container ยังอยู่จริง → degraded_at ยังเป็น null
 * - project ที่ไม่ใช่ 'running' → ไม่ถูกแตะ
 * - orphan container (label ครบแต่ deployment ไม่มีใน DB) → onLog ถูกเรียก, ไม่มีการลบ
 * - container label ตรงกับ deployment ที่มีจริง → ไม่ report เป็น orphan
 * - setProjectStatus เคลียร์ degraded_at
 */
import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { LABELS, ulid } from "@zixploy/shared";
import { markProjectDegraded, setProjectStatus } from "../src/db/project-config";
import { reconcileOnce } from "../src/reconciler";

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function insertProject(db: ReturnType<typeof makeDb>, opts: { status?: string } = {}): string {
  const id = ulid();
  db.query(
    `INSERT INTO projects
      (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'p', ?, 'Dockerfile', '.', 'unless-stopped', 900, 1, 1)`,
  ).run(id, opts.status ?? "running");
  return id;
}

function insertSucceededDeployment(
  db: ReturnType<typeof makeDb>,
  projectId: string,
  containerId: string,
): string {
  const id = ulid();
  db.query(
    `INSERT INTO deployments
       (id, project_id, status, trigger, commit_sha, container_id, queued_at, finished_at, created_at, updated_at)
     VALUES (?, ?, 'succeeded', 'push', ?, ?, 1, 1, 1, 1)`,
  ).run(id, projectId, "a".repeat(40), containerId);
  return id;
}

function getDegradedAt(db: ReturnType<typeof makeDb>, projectId: string): number | null {
  return db
    .query<{ degraded_at: number | null }, [string]>(
      "SELECT degraded_at FROM projects WHERE id = ?",
    )
    .get(projectId)!.degraded_at;
}

function makeMockDocker(opts: {
  inspectContainer?: (id: string) => Promise<unknown>;
  listContainersByLabel?: (labels: Record<string, string>) => Promise<unknown[]>;
}) {
  return {
    inspectContainer: opts.inspectContainer ?? (async () => null),
    listContainersByLabel: opts.listContainersByLabel ?? (async () => []),
  };
}

async function runOnce(
  db: ReturnType<typeof makeDb>,
  docker: ReturnType<typeof makeMockDocker>,
  onLog: (line: string) => void = () => {},
): Promise<void> {
  await reconcileOnce(db, docker as unknown as Parameters<typeof reconcileOnce>[1], onLog);
}

describe("reconciler: active container missing", () => {
  test("project running + container หายไปจาก Docker → degraded_at ถูกตั้ง", async () => {
    const db = makeDb();
    const projectId = insertProject(db, { status: "running" });
    insertSucceededDeployment(db, projectId, "ctr-missing");

    const logs: string[] = [];
    const docker = makeMockDocker({ inspectContainer: async () => null });
    await runOnce(db, docker, (line) => logs.push(line));

    expect(getDegradedAt(db, projectId)).not.toBeNull();
    expect(logs.some((l) => l.includes("mark degraded"))).toBe(true);
  });

  test("project running + container ยังอยู่จริง → degraded_at ยังเป็น null", async () => {
    const db = makeDb();
    const projectId = insertProject(db, { status: "running" });
    insertSucceededDeployment(db, projectId, "ctr-alive");

    const docker = makeMockDocker({
      inspectContainer: async () => ({ Id: "ctr-alive", State: { Running: true } }),
    });
    await runOnce(db, docker);

    expect(getDegradedAt(db, projectId)).toBeNull();
  });

  test("project ที่ไม่ใช่ running (เช่น stopped) → ไม่ถูกแตะแม้ container หาย", async () => {
    const db = makeDb();
    const projectId = insertProject(db, { status: "stopped" });
    insertSucceededDeployment(db, projectId, "ctr-missing");

    const docker = makeMockDocker({ inspectContainer: async () => null });
    await runOnce(db, docker);

    expect(getDegradedAt(db, projectId)).toBeNull();
  });

  test("mark degraded ครั้งเดียว — เรียกซ้ำไม่ log ซ้ำ (idempotent)", async () => {
    const db = makeDb();
    const projectId = insertProject(db, { status: "running" });
    insertSucceededDeployment(db, projectId, "ctr-missing");
    const docker = makeMockDocker({ inspectContainer: async () => null });

    const firstLogs: string[] = [];
    await runOnce(db, docker, (line) => firstLogs.push(line));
    expect(firstLogs.length).toBeGreaterThan(0);

    const secondLogs: string[] = [];
    await runOnce(db, docker, (line) => secondLogs.push(line));
    expect(secondLogs.length).toBe(0); // degraded_at ตั้งแล้ว ไม่ log ซ้ำ
  });

  test("setProjectStatus เคลียร์ degraded_at (redeploy สำเร็จ → กลับมา running ปกติ)", () => {
    const db = makeDb();
    const projectId = insertProject(db, { status: "running" });
    markProjectDegraded(db, projectId);
    expect(getDegradedAt(db, projectId)).not.toBeNull();

    setProjectStatus(db, projectId, "running");
    expect(getDegradedAt(db, projectId)).toBeNull();
  });
});

describe("reconciler: orphan containers", () => {
  test("container label ครบแต่ deployment ไม่มีใน DB → report-only (onLog)", async () => {
    const db = makeDb();
    const projectId = insertProject(db, { status: "running" });

    const docker = makeMockDocker({
      listContainersByLabel: async () => [
        {
          ID: "ctr-orphan",
          Labels: `${LABELS.managed}=true,${LABELS.projectId}=${projectId},${LABELS.deploymentId}=nonexistent-deploy`,
        },
      ],
    });

    const logs: string[] = [];
    await runOnce(db, docker, (line) => logs.push(line));

    expect(logs.some((l) => l.includes("orphan container") && l.includes("ctr-orphan"))).toBe(true);
  });

  test("container label ตรงกับ deployment ที่มีจริง → ไม่ report เป็น orphan", async () => {
    const db = makeDb();
    const projectId = insertProject(db, { status: "running" });
    const deploymentId = insertSucceededDeployment(db, projectId, "ctr-known");

    const docker = makeMockDocker({
      listContainersByLabel: async () => [
        {
          ID: "ctr-known",
          Labels: `${LABELS.managed}=true,${LABELS.projectId}=${projectId},${LABELS.deploymentId}=${deploymentId}`,
        },
      ],
    });

    const logs: string[] = [];
    await runOnce(db, docker, (line) => logs.push(line));

    expect(logs.some((l) => l.includes("orphan"))).toBe(false);
  });

  test("container ไม่มี ownership label ครบ → ข้าม ไม่ report", async () => {
    const db = makeDb();
    insertProject(db, { status: "running" });

    const docker = makeMockDocker({
      listContainersByLabel: async () => [{ ID: "ctr-unrelated", Labels: "some.other.label=x" }],
    });

    const logs: string[] = [];
    await runOnce(db, docker, (line) => logs.push(line));

    expect(logs.length).toBe(0);
  });
});
