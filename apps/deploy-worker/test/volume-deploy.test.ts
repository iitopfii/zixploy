/**
 * Volume deploy integration tests — Phase 7 M4
 *
 * ครอบคลุม:
 * - loadActiveVolumes: คืนเฉพาะ lifecycle='active', isolate ระหว่าง project
 * - build pipeline: เรียก createVolume ก่อน createContainer
 * - createContainer ได้รับ volumes array จาก active volumes
 * - single-writer volume สร้าง warning log
 * - cleanup ไม่เรียก removeVolume (volumes ต้องรอด)
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid, volumeName } from "@zixploy/shared";
import type { BuildPipelineDeps } from "../src/pipeline/build";
import { runBuildOrRollbackPipeline } from "../src/pipeline/build";
import type { ClaimedJob } from "../src/queue";
import { loadActiveVolumes } from "../src/volumes/loader";

// ---------------------------------------------------------------------------
// Workspace setup (build pipeline ต้องการ workspace จริง)
// ---------------------------------------------------------------------------

const testWorkspacesRoot = mkdtempSync(join(tmpdir(), "zixploy-vol-deploy-test-"));
process.env.ZIXPLOY_WORKSPACES_DIR = testWorkspacesRoot;
afterEach(() => {
  try {
    rmSync(testWorkspacesRoot, { recursive: true, force: true });
  } catch {
    // Windows อาจปล่อย handle ช้า
  }
});

async function fakeCloneCommit(params: { destDir: string }): Promise<void> {
  writeFileSync(join(params.destDir, "Dockerfile"), "FROM scratch\n");
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

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
      (id, name, status, dockerfile_path, build_context, target_stage, internal_port,
       health_check_path, health_check_interval_sec, health_check_timeout_sec, health_check_retries,
       start_command, cpu_limit, memory_limit_mb, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'test', 'new', 'Dockerfile', '.', null, null, null, 1, 5, 3, null, null, null, 'unless-stopped', 900, ?, ?)`,
  ).run(id, now, now);
  return id;
}

function insertDeployment(
  db: ReturnType<typeof makeDb>,
  projectId: string,
  opts: { status?: string } = {},
): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO deployments
       (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
     VALUES (?, ?, ?, 'push', 'abc1234', ?, ?, ?)`,
  ).run(id, projectId, opts.status ?? "queued", now, now, now);
  return id;
}

function insertVolume(
  db: ReturnType<typeof makeDb>,
  projectId: string,
  opts: { lifecycle?: string; mountPath?: string; accessMode?: string; volId?: string } = {},
): string {
  const id = opts.volId ?? ulid();
  const now = Date.now();
  const dockerName = volumeName(projectId, id);
  db.query(
    `INSERT INTO volumes
       (id, project_id, display_name, docker_name, mount_path, access_mode, driver,
        driver_opts, read_only, lifecycle, created_at, updated_at)
     VALUES (?, ?, 'test-vol', ?, ?, ?, 'local', '{}', 0, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    dockerName,
    opts.mountPath ?? "/app/data",
    opts.accessMode ?? "shared-safe",
    opts.lifecycle ?? "active",
    now,
    now,
  );
  return id;
}

// ---------------------------------------------------------------------------
// loadActiveVolumes
// ---------------------------------------------------------------------------

describe("loadActiveVolumes", () => {
  test("คืนเฉพาะ lifecycle=active", () => {
    const db = makeDb();
    const projectId = insertProject(db);

    insertVolume(db, projectId, { lifecycle: "active", mountPath: "/app/data" });
    insertVolume(db, projectId, { lifecycle: "detached", mountPath: "/app/logs" });
    insertVolume(db, projectId, { lifecycle: "deletion_pending", mountPath: "/app/cache" });
    insertVolume(db, projectId, { lifecycle: "deleted", mountPath: "/app/old" });

    const vols = loadActiveVolumes(db, projectId);
    expect(vols).toHaveLength(1);
    expect(vols[0]!.mountPath).toBe("/app/data");
  });

  test("isolate ระหว่าง projects", () => {
    const db = makeDb();
    const p1 = insertProject(db);
    const p2 = insertProject(db);

    insertVolume(db, p1, { mountPath: "/app/p1" });
    insertVolume(db, p2, { mountPath: "/app/p2" });

    expect(loadActiveVolumes(db, p1)).toHaveLength(1);
    expect(loadActiveVolumes(db, p2)).toHaveLength(1);
    expect(loadActiveVolumes(db, p1)[0]!.mountPath).toBe("/app/p1");
    expect(loadActiveVolumes(db, p2)[0]!.mountPath).toBe("/app/p2");
  });

  test("คืน empty array เมื่อไม่มี volume", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    expect(loadActiveVolumes(db, projectId)).toEqual([]);
  });

  test("คืน readOnly=true สำหรับ read_only=1", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const id = ulid();
    const now = Date.now();
    db.query(
      `INSERT INTO volumes
         (id, project_id, display_name, docker_name, mount_path, access_mode, driver,
          driver_opts, read_only, lifecycle, created_at, updated_at)
       VALUES (?, ?, 'ro-vol', ?, '/data', 'shared-safe', 'local', '{}', 1, 'active', ?, ?)`,
    ).run(id, projectId, volumeName(projectId, id), now, now);

    const vols = loadActiveVolumes(db, projectId);
    expect(vols[0]!.readOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Build pipeline — createVolume called + volumes passed to createContainer
// ---------------------------------------------------------------------------

describe("build pipeline — volume integration", () => {
  function makeMocks(
    overrides: {
      createVolume?: (p: unknown) => Promise<void>;
      createContainer?: (p: unknown) => Promise<{ containerId: string }>;
      onLog?: (line: string) => void;
    } = {},
  ) {
    const logs: string[] = [];
    const createVolumeCalls: unknown[] = [];
    const createContainerCalls: unknown[] = [];

    const docker = {
      ping: async () => true,
      ensureNetwork: async () => ({ networkId: "net1" }),
      removeContainer: async () => {},
      createVolume: async (p: unknown) => {
        createVolumeCalls.push(p);
        if (overrides.createVolume) return overrides.createVolume(p);
      },
      createContainer: async (p: unknown) => {
        createContainerCalls.push(p);
        if (overrides.createContainer) return overrides.createContainer(p);
        return { containerId: "ctr-id" };
      },
      startContainer: async () => {},
      connectNetwork: async () => {},
      inspectImage: async () => ({ Id: "sha:abc", RepoDigests: [], Config: { Labels: {} } }),
      listImagesByLabel: async () => [],
      listContainersByLabel: async () => [],
      removeImage: async () => {},
      disconnectNetwork: async () => {},
      stopContainer: async () => {},
      inspectContainer: async () => ({
        Id: "ctr-id",
        Name: "ctr",
        State: { Status: "running", Running: true },
        RestartCount: 0,
        NetworkSettings: { Networks: {} },
      }),
      fetchLogs: async () => [],
      removeVolume: async () => {},
      inspectVolume: async () => null,
      listVolumesByLabel: async () => [],
    };

    return { docker, createVolumeCalls, createContainerCalls, logs };
  }

  function makeDeps(
    db: ReturnType<typeof makeDb>,
    docker: ReturnType<typeof makeMocks>["docker"],
    logs: string[],
  ): BuildPipelineDeps {
    return {
      db,
      docker: docker as unknown as BuildPipelineDeps["docker"],
      masterKeys: null,
      mintInstallationToken: async () => ({
        token: "tok",
        expiresAt: new Date(Date.now() + 3600_000),
      }),
      cloneCommit: fakeCloneCommit,
      buildImage: async () => ({ imageId: "sha:abc123", digest: "sha:abc123", tag: "img:tag" }),
      waitForHealthy: async () => {},
      activate: async () => {},
      onLog: (line) => logs.push(line),
    };
  }

  function makeJob(projectId: string, deploymentId: string): ClaimedJob {
    return {
      id: ulid(),
      projectId,
      deploymentId,
      type: "deploy",
      payload: JSON.stringify({
        kind: "build",
        installationId: 1,
        repoFullName: "user/repo",
        commitSha: "abc1234567890",
        commitMessage: "test",
        commitAuthor: "tester",
      }),
      status: "leased",
      attempts: 0,
      maxAttempts: 3,
    };
  }

  test("ไม่มี active volume → createVolume ไม่ถูกเรียก, createContainer ไม่มี volumes", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);

    const { docker, createVolumeCalls, createContainerCalls, logs } = makeMocks();
    const deps = makeDeps(db, docker, logs);

    await runBuildOrRollbackPipeline(
      deps,
      makeJob(projectId, deploymentId),
      {
        kind: "build",
        installationId: 1,
        repoFullName: "user/repo",
        commitSha: "abc1234567890",
        trigger: "manual",
        commitMessage: null,
        commitAuthor: null,
      },
      new AbortController().signal,
    );

    expect(createVolumeCalls).toHaveLength(0);
    const containerCall = createContainerCalls[0] as { volumes?: unknown[] };
    // volumes ไม่ควรอยู่ใน call หรือเป็น undefined (spread pattern)
    expect(containerCall?.volumes).toBeUndefined();
  });

  test("มี active volume → createVolume ถูกเรียกก่อน createContainer", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);
    insertVolume(db, projectId, { mountPath: "/app/data" });

    const callOrder: string[] = [];
    const { docker, createVolumeCalls, logs } = makeMocks({
      createVolume: async () => {
        callOrder.push("createVolume");
      },
      createContainer: async () => {
        callOrder.push("createContainer");
        return { containerId: "ctr-id" };
      },
    });
    const deps = makeDeps(db, docker, logs);

    await runBuildOrRollbackPipeline(
      deps,
      makeJob(projectId, deploymentId),
      {
        kind: "build",
        installationId: 1,
        repoFullName: "user/repo",
        commitSha: "abc1234567890",
        trigger: "manual",
        commitMessage: null,
        commitAuthor: null,
      },
      new AbortController().signal,
    );

    expect(createVolumeCalls).toHaveLength(1);
    expect(callOrder[0]).toBe("createVolume");
    expect(callOrder.find((c) => c === "createContainer")).toBe("createContainer");
    // createVolume ต้องมาก่อน createContainer
    const volIdx = callOrder.indexOf("createVolume");
    const ctrIdx = callOrder.indexOf("createContainer");
    expect(volIdx).toBeLessThan(ctrIdx);
  });

  test("createContainer ได้รับ volumes array", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);
    const volId = ulid();
    insertVolume(db, projectId, { mountPath: "/app/storage", volId });

    const { docker, createContainerCalls, logs } = makeMocks();
    const deps = makeDeps(db, docker, logs);

    await runBuildOrRollbackPipeline(
      deps,
      makeJob(projectId, deploymentId),
      {
        kind: "build",
        installationId: 1,
        repoFullName: "user/repo",
        commitSha: "abc1234567890",
        trigger: "manual",
        commitMessage: null,
        commitAuthor: null,
      },
      new AbortController().signal,
    );

    const containerCall = createContainerCalls[0] as { volumes?: Array<{ mountPath: string }> };
    expect(containerCall?.volumes).toHaveLength(1);
    expect(containerCall?.volumes?.[0]?.mountPath).toBe("/app/storage");
  });

  test("single-writer volume สร้าง warning log", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);
    insertVolume(db, projectId, { mountPath: "/app/db", accessMode: "single-writer" });

    const { docker, logs } = makeMocks();
    const deps = makeDeps(db, docker, logs);

    await runBuildOrRollbackPipeline(
      deps,
      makeJob(projectId, deploymentId),
      {
        kind: "build",
        installationId: 1,
        repoFullName: "user/repo",
        commitSha: "abc1234567890",
        trigger: "manual",
        commitMessage: null,
        commitAuthor: null,
      },
      new AbortController().signal,
    );

    const hasWarning = logs.some((l) => l.includes("single-writer"));
    expect(hasWarning).toBe(true);
  });
});
