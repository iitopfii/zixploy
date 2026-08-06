import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { AppError, ulid } from "@zixploy/shared";
import { runRestart, runStop } from "../src/pipeline/restart-stop";
import type { ClaimedJob } from "../src/queue";

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function insertProject(db: ReturnType<typeof openDatabase>) {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO projects (id, name, status, dockerfile_path, build_context, created_at, updated_at)
     VALUES (?, 'p', 'running', 'Dockerfile', '.', ?, ?)`,
  ).run(id, now, now);
  return id;
}

function insertDeployment(
  db: ReturnType<typeof openDatabase>,
  projectId: string,
  containerId: string | null,
) {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, container_id, queued_at, finished_at, created_at, updated_at)
     VALUES (?, ?, 'succeeded', 'manual', ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, "a".repeat(40), containerId, now, now, now, now);
  return id;
}

function makeJob(projectId: string, deploymentId: string | null): ClaimedJob {
  return {
    id: ulid(),
    projectId,
    deploymentId,
    type: "deploy",
    status: "leased",
    payload: {},
    attempts: 1,
    maxAttempts: 1,
  };
}

function mockDocker(overrides: Record<string, unknown> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, impl: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return impl(...args);
    };
  return {
    calls,
    stopContainer: record("stopContainer", async () => undefined),
    startContainer: record("startContainer", async () => undefined),
    ...overrides,
  };
}

describe("runRestart", () => {
  test("stop แล้ว start container ตามลำดับ", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId, "c1");
    const job = makeJob(projectId, deploymentId);
    const docker = mockDocker();

    const result = await runRestart(db, docker as unknown as Parameters<typeof runRestart>[1], job);

    expect(result.outcome).toBe("done");
    expect(docker.calls.map((c) => c.method)).toEqual(["stopContainer", "startContainer"]);
    expect(docker.calls[0]?.args[0]).toBe("c1");
  });

  test("job.deploymentId เป็น null → failed ไม่ retryable", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const job = makeJob(projectId, null);
    const docker = mockDocker();

    const result = await runRestart(db, docker as unknown as Parameters<typeof runRestart>[1], job);
    expect(result).toEqual({ outcome: "failed", retryable: false });
    expect(docker.calls.length).toBe(0);
  });

  test("deployment ไม่มี container_id (ยังไม่เคย deploy สำเร็จ) → failed ไม่ retryable", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId, null);
    const job = makeJob(projectId, deploymentId);
    const docker = mockDocker();

    const result = await runRestart(db, docker as unknown as Parameters<typeof runRestart>[1], job);
    expect(result).toEqual({ outcome: "failed", retryable: false });
  });

  test("docker throw AppError (เช่น container หายไปแล้ว) → failed ไม่ retryable, ไม่ throw ต่อ", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId, "c1");
    const job = makeJob(projectId, deploymentId);
    const docker = mockDocker({
      stopContainer: async () => {
        throw new AppError("DOCKER_UNAVAILABLE", "daemon ไม่พร้อม");
      },
    });

    const result = await runRestart(db, docker as unknown as Parameters<typeof runRestart>[1], job);
    expect(result).toEqual({ outcome: "failed", retryable: false });
  });

  test("docker throw error ที่ไม่ใช่ AppError → re-throw ให้ caller จัดการเป็น unexpected", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId, "c1");
    const job = makeJob(projectId, deploymentId);
    const docker = mockDocker({
      stopContainer: async () => {
        throw new Error("unexpected bug");
      },
    });

    await expect(
      runRestart(db, docker as unknown as Parameters<typeof runRestart>[1], job),
    ).rejects.toThrow("unexpected bug");
  });
});

describe("runStop", () => {
  test("stop container แล้วตั้ง project.status เป็น stopped", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId, "c1");
    const job = makeJob(projectId, deploymentId);
    const docker = mockDocker();

    const result = await runStop(db, docker as unknown as Parameters<typeof runStop>[1], job);

    expect(result.outcome).toBe("done");
    expect(docker.calls.map((c) => c.method)).toEqual(["stopContainer"]);
    const project = db
      .query<{ status: string }, [string]>("SELECT status FROM projects WHERE id = ?")
      .get(projectId);
    expect(project?.status).toBe("stopped");
  });

  test("job.deploymentId เป็น null → failed ไม่ retryable, project status ไม่ถูกแตะ", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const job = makeJob(projectId, null);
    const docker = mockDocker();

    const result = await runStop(db, docker as unknown as Parameters<typeof runStop>[1], job);
    expect(result).toEqual({ outcome: "failed", retryable: false });
    const project = db
      .query<{ status: string }, [string]>("SELECT status FROM projects WHERE id = ?")
      .get(projectId);
    expect(project?.status).toBe("running");
  });
});
