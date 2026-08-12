/**
 * runBuildOrRollbackPipeline tests — mock ทุก dependency ภายนอก (Docker, clone, token minting,
 * build, health check, activate) ผ่าน injection เต็มรูปแบบ ไม่ต้องมี Docker/GitHub จริง
 *
 * หมายเหตุ: createWorkspace/removeWorkspace/assertDockerfileWithinContext เป็นของจริง (import ตรง
 * ใน build.ts ไม่ได้ inject) เพราะเป็น pure filesystem logic ที่ทดสอบแยกแล้วใน workspace.test.ts —
 * mock cloneCommit ในเทสต์นี้จึงต้องเขียน Dockerfile ลง destDir จริง ๆ ให้ assertDockerfileWithinContext
 * เจอ ไม่งั้นทุก happy-path test จะพัง DOCKERFILE_NOT_FOUND ตั้งแต่ก่อนถึงจุดที่ตั้งใจทดสอบ
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { AppError, ulid } from "@zixploy/shared";
import type { BuildPipelineDeps } from "../src/pipeline/build";
import { runBuildOrRollbackPipeline } from "../src/pipeline/build";
import type { ClaimedJob } from "../src/queue";

const testWorkspacesRoot = mkdtempSync(join(tmpdir(), "zixploy-pipeline-build-test-"));
process.env.ZIXPLOY_WORKSPACES_DIR = testWorkspacesRoot;
afterEach(() => {
  try {
    rmSync(testWorkspacesRoot, { recursive: true, force: true });
  } catch {
    // Windows อาจปล่อย handle ช้า — ปล่อยให้ OS เก็บกวาด
  }
});

/** mock cloneCommit เริ่มต้น — เขียน Dockerfile จริงลง destDir ให้ assertDockerfileWithinContext ผ่าน */
async function fakeCloneCommit(params: { destDir: string }): Promise<void> {
  writeFileSync(join(params.destDir, "Dockerfile"), "FROM scratch\n");
}

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function insertProject(
  db: ReturnType<typeof openDatabase>,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO projects
      (id, name, status, dockerfile_path, build_context, target_stage, internal_port,
       health_check_path, health_check_interval_sec, health_check_timeout_sec, health_check_retries,
       start_command, cpu_limit, memory_limit_mb, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'test', 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    (overrides.dockerfilePath as string) ?? "Dockerfile",
    (overrides.buildContext as string) ?? ".",
    (overrides.targetStage as string | null) ?? null,
    (overrides.internalPort as number | null) ?? null,
    (overrides.healthCheckPath as string | null) ?? null,
    (overrides.healthCheckIntervalSec as number) ?? 1,
    (overrides.healthCheckTimeoutSec as number) ?? 5,
    (overrides.healthCheckRetries as number) ?? 3,
    (overrides.startCommand as string | null) ?? null,
    (overrides.cpuLimit as number | null) ?? null,
    (overrides.memoryLimitMb as number | null) ?? null,
    (overrides.restartPolicy as string) ?? "unless-stopped",
    (overrides.deployTimeoutSec as number) ?? 900,
    now,
    now,
  );
  return id;
}

function insertDeployment(
  db: ReturnType<typeof openDatabase>,
  projectId: string,
  opts: { status?: string; trigger?: string; commitSha?: string } = {},
) {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    opts.status ?? "queued",
    opts.trigger ?? "manual",
    opts.commitSha ?? "a".repeat(40),
    now,
    now,
    now,
  );
  return id;
}

function makeJob(projectId: string, deploymentId: string): ClaimedJob {
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

/** mock DockerCliClient — เฉพาะ method ที่ build pipeline เรียกจริง */
function mockDocker(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, impl: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return impl(...args);
    };

  const docker = {
    calls,
    ping: record("ping", async () => true),
    removeContainer: record("removeContainer", async () => undefined),
    ensureNetwork: record("ensureNetwork", async () => ({ networkId: "net1" })),
    createContainer: record("createContainer", async () => ({ containerId: "container-1" })),
    startContainer: record("startContainer", async () => undefined),
    stopContainer: record("stopContainer", async () => undefined),
    inspectContainer: record("inspectContainer", async () => ({
      Id: "container-1",
      Name: "/test",
      State: { Status: "running", Running: true },
      RestartCount: 0,
      NetworkSettings: { Networks: {} },
    })),
    inspectImage: record("inspectImage", async () => null),
    // retention cleanup (M7) เรียกทุกครั้งหลัง succeeded — default ว่างเปล่า ไม่มี image ให้จัดการ
    listContainersByLabel: record("listContainersByLabel", async () => []),
    listImagesByLabel: record("listImagesByLabel", async () => []),
    removeImage: record("removeImage", async () => undefined),
    ...overrides,
  };
  return docker;
}

function baseDeps(overrides: Partial<BuildPipelineDeps> = {}): BuildPipelineDeps {
  return {
    db: overrides.db!,
    // biome-ignore lint/suspicious/noExplicitAny: mock docker client — ไม่ implement ทุก method ของ interface จริง
    docker: mockDocker() as any,
    masterKeys: null,
    mintInstallationToken: async () => ({ token: "test-token", expiresAt: new Date() }),
    cloneCommit: fakeCloneCommit,
    buildImage: async () => ({ imageId: "sha256:abc123", digest: "sha256:abc123" }),
    waitForHealthy: async () => undefined,
    activate: async () => undefined,
    onLog: () => {},
    ...overrides,
  };
}

describe("runBuildOrRollbackPipeline — happy path (build)", () => {
  test("เดินผ่านทุก state จนถึง succeeded ตามลำดับที่ถูกต้อง", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);
    const job = makeJob(projectId, deploymentId);

    const deps = baseDeps({ db });
    const result = await runBuildOrRollbackPipeline(
      deps,
      job,
      {
        kind: "build",
        trigger: "manual",
        commitSha: "a".repeat(40),
        commitMessage: null,
        commitAuthor: null,
        source: { type: "github", installationId: 111, repoFullName: "org/repo" },
      },
      new AbortController().signal,
    );

    expect(result.outcome).toBe("done");

    const deployment = db
      .query<
        {
          status: string;
          cloning_at: number | null;
          building_at: number | null;
          starting_at: number | null;
          health_checking_at: number | null;
          activating_at: number | null;
          finished_at: number | null;
          image_tag: string | null;
          container_id: string | null;
        },
        [string]
      >("SELECT * FROM deployments WHERE id = ?")
      .get(deploymentId);

    expect(deployment?.status).toBe("succeeded");
    expect(deployment?.cloning_at).not.toBeNull();
    expect(deployment?.building_at).not.toBeNull();
    expect(deployment?.starting_at).not.toBeNull();
    expect(deployment?.health_checking_at).not.toBeNull();
    expect(deployment?.activating_at).not.toBeNull();
    expect(deployment?.finished_at).not.toBeNull();
    expect(deployment?.image_tag).not.toBeNull();
    expect(deployment?.container_id).toBe("container-1");

    const project = db
      .query<{ status: string }, [string]>("SELECT status FROM projects WHERE id = ?")
      .get(projectId);
    expect(project?.status).toBe("running");
  });

  test("ไม่มี deployment เก่า (deploy ครั้งแรก) → activate ถูกเรียกด้วย oldContainerId: null", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);
    const job = makeJob(projectId, deploymentId);

    const captured: { activateCalledWith: { oldContainerId: string | null } | null } = {
      activateCalledWith: null,
    };
    const deps = baseDeps({
      db,
      activate: async (params) => {
        captured.activateCalledWith = { oldContainerId: params.oldContainerId };
      },
    });

    await runBuildOrRollbackPipeline(
      deps,
      job,
      {
        kind: "build",
        trigger: "manual",
        commitSha: "a".repeat(40),
        commitMessage: null,
        commitAuthor: null,
        source: { type: "github", installationId: 111, repoFullName: "org/repo" },
      },
      new AbortController().signal,
    );

    expect(captured.activateCalledWith).not.toBeNull();
    expect(captured.activateCalledWith?.oldContainerId).toBeNull();
  });

  test("มี deployment succeeded เก่าอยู่ → activate ได้ oldContainerId ที่ถูกต้อง", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const now = Date.now();
    const oldDeploymentId = ulid();
    db.query(
      `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, container_id, queued_at, finished_at, created_at, updated_at)
       VALUES (?, ?, 'succeeded', 'push', ?, 'old-container-99', ?, ?, ?, ?)`,
    ).run(oldDeploymentId, projectId, "b".repeat(40), now, now, now, now);

    const deploymentId = insertDeployment(db, projectId);
    const job = makeJob(projectId, deploymentId);

    const captured: { activateCalledWith: { oldContainerId: string | null } | null } = {
      activateCalledWith: null,
    };
    const deps = baseDeps({
      db,
      activate: async (params) => {
        captured.activateCalledWith = { oldContainerId: params.oldContainerId };
      },
    });

    await runBuildOrRollbackPipeline(
      deps,
      job,
      {
        kind: "build",
        trigger: "manual",
        commitSha: "a".repeat(40),
        commitMessage: null,
        commitAuthor: null,
        source: { type: "github", installationId: 111, repoFullName: "org/repo" },
      },
      new AbortController().signal,
    );

    expect(captured.activateCalledWith?.oldContainerId).toBe("old-container-99");
  });
});

describe("runBuildOrRollbackPipeline — dockerfile-paste source (Phase 13)", () => {
  test("ไม่มี git clone/mint token เลย — เขียน Dockerfile ที่วางเองลง build context ตรง ๆ แล้ว build สำเร็จ", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);
    const job = makeJob(projectId, deploymentId);

    let cloneCalled = false;
    let mintTokenCalled = false;
    let writtenContent = "";
    const deps = baseDeps({
      db,
      cloneCommit: async () => {
        cloneCalled = true;
      },
      mintInstallationToken: async () => {
        mintTokenCalled = true;
        return { token: "unused", expiresAt: new Date() };
      },
      buildImage: async (params) => {
        // ยังไม่ถูกลบเพราะ removeWorkspace() รันหลัง buildImage() resolve เท่านั้น (ดู pipeline/build.ts finally)
        writtenContent = readFileSync(join(params.contextDir, "Dockerfile"), "utf8");
        return { imageId: "sha256:abc123", digest: "sha256:abc123" };
      },
    });

    const pastedContent = "FROM scratch\nCOPY . /app\n";
    const result = await runBuildOrRollbackPipeline(
      deps,
      job,
      {
        kind: "build",
        trigger: "manual",
        commitSha: "deadbeef".repeat(5),
        commitMessage: null,
        commitAuthor: null,
        source: { type: "dockerfile", dockerfileContent: pastedContent },
      },
      new AbortController().signal,
    );

    expect(result.outcome).toBe("done");
    // ไม่มี clone / mint token เกิดขึ้นเลย — สอง dependency ที่ผูกกับ GitHub เฉพาะ
    expect(cloneCalled).toBe(false);
    expect(mintTokenCalled).toBe(false);

    const deployment = db
      .query<{ status: string }, [string]>("SELECT status FROM deployments WHERE id = ?")
      .get(deploymentId);
    expect(deployment?.status).toBe("succeeded");

    // เนื้อหาที่เขียนลง workspace ต้องตรงกับที่วางไว้เป๊ะ
    expect(writtenContent).toBe(pastedContent);
  });
});

describe("runBuildOrRollbackPipeline — exposed port (Phase 14)", () => {
  const PAYLOAD = {
    kind: "build" as const,
    trigger: "manual" as const,
    commitSha: "a".repeat(40),
    commitMessage: null,
    commitAuthor: null,
    source: { type: "github" as const, installationId: 111, repoFullName: "org/repo" },
  };

  function insertOldSucceeded(
    db: ReturnType<typeof makeDb>,
    projectId: string,
    containerId: string,
  ) {
    const now = Date.now();
    db.query(
      `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, container_id, queued_at, finished_at, created_at, updated_at)
       VALUES (?, ?, 'succeeded', 'push', ?, ?, ?, ?, ?, ?)`,
    ).run(ulid(), projectId, "b".repeat(40), containerId, now, now, now, now);
  }

  test("exposedPort ตั้งไว้ → createContainer ได้ publishPorts host:container ถูกต้อง", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    db.query("UPDATE projects SET exposed_port = 3100, internal_port = 3000 WHERE id = ?").run(
      projectId,
    );
    const deploymentId = insertDeployment(db, projectId);
    const docker = mockDocker();

    const deps = baseDeps({ db, docker: docker as unknown as BuildPipelineDeps["docker"] });
    const result = await runBuildOrRollbackPipeline(
      deps,
      makeJob(projectId, deploymentId),
      PAYLOAD,
      new AbortController().signal,
    );

    expect(result.outcome).toBe("done");
    const createCall = docker.calls.find((c) => c.method === "createContainer");
    const params = createCall?.args[0] as {
      publishPorts?: { hostPort: number; containerPort: number }[];
    };
    expect(params.publishPorts).toEqual([{ hostPort: 3100, containerPort: 3000 }]);
  });

  test("มี container เก่า → หยุดของเก่าก่อน start candidate (host port ผูกได้ตัวเดียว)", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    db.query("UPDATE projects SET exposed_port = 3100, internal_port = 3000 WHERE id = ?").run(
      projectId,
    );
    insertOldSucceeded(db, projectId, "old-holding-port");
    const deploymentId = insertDeployment(db, projectId);
    const docker = mockDocker();

    const deps = baseDeps({ db, docker: docker as unknown as BuildPipelineDeps["docker"] });
    await runBuildOrRollbackPipeline(
      deps,
      makeJob(projectId, deploymentId),
      PAYLOAD,
      new AbortController().signal,
    );

    const stopIdx = docker.calls.findIndex(
      (c) => c.method === "stopContainer" && c.args[0] === "old-holding-port",
    );
    const startIdx = docker.calls.findIndex((c) => c.method === "startContainer");
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(stopIdx);
  });

  test("candidate ล้มเหลวหลังหยุดของเก่า → restart ของเก่าคืน (ลด downtime จาก failure)", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    db.query("UPDATE projects SET exposed_port = 3100, internal_port = 3000 WHERE id = ?").run(
      projectId,
    );
    insertOldSucceeded(db, projectId, "old-holding-port");
    const deploymentId = insertDeployment(db, projectId);
    const docker = mockDocker();

    const deps = baseDeps({
      db,
      docker: docker as unknown as BuildPipelineDeps["docker"],
      waitForHealthy: async () => {
        throw new AppError("HEALTH_CHECK_FAILED", "health check ไม่ผ่าน");
      },
    });
    const result = await runBuildOrRollbackPipeline(
      deps,
      makeJob(projectId, deploymentId),
      PAYLOAD,
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    // ของเก่าถูก start คืนหลัง candidate ล้มเหลว
    expect(
      docker.calls.some((c) => c.method === "startContainer" && c.args[0] === "old-holding-port"),
    ).toBe(true);
  });

  test("ไม่ตั้ง exposedPort → ไม่มี publishPorts และไม่หยุดของเก่าก่อน start (ADR-0004 เดิม)", async () => {
    const db = makeDb();
    const projectId = insertProject(db, { internalPort: 3000 });
    insertOldSucceeded(db, projectId, "old-container");
    const deploymentId = insertDeployment(db, projectId);
    const docker = mockDocker();

    const deps = baseDeps({ db, docker: docker as unknown as BuildPipelineDeps["docker"] });
    await runBuildOrRollbackPipeline(
      deps,
      makeJob(projectId, deploymentId),
      PAYLOAD,
      new AbortController().signal,
    );

    const params = docker.calls.find((c) => c.method === "createContainer")?.args[0] as {
      publishPorts?: unknown;
    };
    expect(params.publishPorts).toBeUndefined();

    // stop ของเก่าเกิดหลัง startContainer เท่านั้น (ใน activate) — ไม่ใช่ก่อน
    const startIdx = docker.calls.findIndex((c) => c.method === "startContainer");
    const stopIdx = docker.calls.findIndex((c) => c.method === "stopContainer");
    if (stopIdx !== -1) expect(stopIdx).toBeGreaterThan(startIdx);
  });
});

describe("runBuildOrRollbackPipeline — failure cases (old container untouched)", () => {
  test("clone ล้มเหลว → deployment failed, candidate container ไม่เคยถูกสร้าง, ของเก่าไม่ถูกแตะ", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);
    const job = makeJob(projectId, deploymentId);
    const docker = mockDocker();

    const deps = baseDeps({
      db,
      // biome-ignore lint/suspicious/noExplicitAny: mock
      docker: docker as any,
      cloneCommit: async () => {
        throw new AppError("CLONE_FAILED", "commit ไม่มีอยู่จริง");
      },
    });

    const result = await runBuildOrRollbackPipeline(
      deps,
      job,
      {
        kind: "build",
        trigger: "manual",
        commitSha: "a".repeat(40),
        commitMessage: null,
        commitAuthor: null,
        source: { type: "github", installationId: 111, repoFullName: "org/repo" },
      },
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    const deployment = db
      .query<{ status: string; failure_code: string | null }, [string]>(
        "SELECT status, failure_code FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(deployment?.status).toBe("failed");
    expect(deployment?.failure_code).toBe("CLONE_FAILED");

    // createContainer ไม่เคยถูกเรียกเลย — clone ล้มเหลวก่อนถึงขั้น starting
    expect(docker.calls.some((c) => c.method === "createContainer")).toBe(false);
    // stopContainer (ของเก่า) ไม่เคยถูกเรียก — ไม่มีของเก่าให้แตะเพราะยังไม่ถึงขั้น activate
    expect(docker.calls.some((c) => c.method === "stopContainer")).toBe(false);
  });

  test("Dockerfile ไม่พบ (path traversal/missing) → BUILD_FAILED หรือ DOCKERFILE_NOT_FOUND, ของเก่าไม่ถูกแตะ", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);
    const job = makeJob(projectId, deploymentId);
    const docker = mockDocker();

    const deps = baseDeps({
      db,
      // biome-ignore lint/suspicious/noExplicitAny: mock
      docker: docker as any,
      buildImage: async () => {
        throw new AppError("DOCKERFILE_NOT_FOUND", "ไม่พบ Dockerfile");
      },
    });

    const result = await runBuildOrRollbackPipeline(
      deps,
      job,
      {
        kind: "build",
        trigger: "manual",
        commitSha: "a".repeat(40),
        commitMessage: null,
        commitAuthor: null,
        source: { type: "github", installationId: 111, repoFullName: "org/repo" },
      },
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    const deployment = db
      .query<{ status: string; failure_code: string | null }, [string]>(
        "SELECT status, failure_code FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(deployment?.status).toBe("failed");
    expect(deployment?.failure_code).toBe("DOCKERFILE_NOT_FOUND");
    expect(docker.calls.some((c) => c.method === "stopContainer")).toBe(false);
  });

  test("build timeout → BUILD_TIMEOUT, ของเก่าไม่ถูกแตะ", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);
    const job = makeJob(projectId, deploymentId);
    const docker = mockDocker();

    const deps = baseDeps({
      db,
      // biome-ignore lint/suspicious/noExplicitAny: mock
      docker: docker as any,
      buildImage: async () => {
        throw new AppError("BUILD_TIMEOUT", "build เกินเวลา");
      },
    });

    const result = await runBuildOrRollbackPipeline(
      deps,
      job,
      {
        kind: "build",
        trigger: "manual",
        commitSha: "a".repeat(40),
        commitMessage: null,
        commitAuthor: null,
        source: { type: "github", installationId: 111, repoFullName: "org/repo" },
      },
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    const deployment = db
      .query<{ failure_code: string | null }, [string]>(
        "SELECT failure_code FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(deployment?.failure_code).toBe("BUILD_TIMEOUT");
    expect(docker.calls.some((c) => c.method === "stopContainer")).toBe(false);
  });

  test("health check ล้มเหลว → HEALTH_CHECK_FAILED, candidate ถูกลบ, ของเก่าไม่ถูกแตะ", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const now = Date.now();
    const oldDeploymentId = ulid();
    db.query(
      `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, container_id, queued_at, finished_at, created_at, updated_at)
       VALUES (?, ?, 'succeeded', 'push', ?, 'old-container-keep-me', ?, ?, ?, ?)`,
    ).run(oldDeploymentId, projectId, "b".repeat(40), now, now, now, now);

    const deploymentId = insertDeployment(db, projectId);
    const job = makeJob(projectId, deploymentId);
    const docker = mockDocker();

    const deps = baseDeps({
      db,
      // biome-ignore lint/suspicious/noExplicitAny: mock
      docker: docker as any,
      waitForHealthy: async () => {
        throw new AppError("HEALTH_CHECK_FAILED", "health check ไม่ผ่าน");
      },
    });

    const result = await runBuildOrRollbackPipeline(
      deps,
      job,
      {
        kind: "build",
        trigger: "manual",
        commitSha: "a".repeat(40),
        commitMessage: null,
        commitAuthor: null,
        source: { type: "github", installationId: 111, repoFullName: "org/repo" },
      },
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    const deployment = db
      .query<{ status: string; failure_code: string | null }, [string]>(
        "SELECT status, failure_code FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(deployment?.status).toBe("failed");
    expect(deployment?.failure_code).toBe("HEALTH_CHECK_FAILED");

    // candidate container (ชื่อ deterministic ตาม containerName) ถูกลบ (removeContainer เรียกใน catch)
    const removeCalls = docker.calls.filter((c) => c.method === "removeContainer");
    expect(removeCalls.length).toBeGreaterThan(0);

    // ของเก่า (old-container-keep-me) ไม่เคยถูก stop/remove — ADR-0004 หลัก
    expect(docker.calls.some((c) => c.method === "stopContainer")).toBe(false);
    expect(
      docker.calls.some(
        (c) => c.method === "removeContainer" && c.args[0] === "old-container-keep-me",
      ),
    ).toBe(false);
  });

  test("crash-loop detection → CONTAINER_CRASH_LOOP, ของเก่าไม่ถูกแตะ", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);
    const job = makeJob(projectId, deploymentId);
    const docker = mockDocker();

    const deps = baseDeps({
      db,
      // biome-ignore lint/suspicious/noExplicitAny: mock
      docker: docker as any,
      waitForHealthy: async () => {
        throw new AppError("CONTAINER_CRASH_LOOP", "container restart ซ้ำ ๆ");
      },
    });

    const result = await runBuildOrRollbackPipeline(
      deps,
      job,
      {
        kind: "build",
        trigger: "manual",
        commitSha: "a".repeat(40),
        commitMessage: null,
        commitAuthor: null,
        source: { type: "github", installationId: 111, repoFullName: "org/repo" },
      },
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    const deployment = db
      .query<{ failure_code: string | null }, [string]>(
        "SELECT failure_code FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(deployment?.failure_code).toBe("CONTAINER_CRASH_LOOP");
    expect(docker.calls.some((c) => c.method === "stopContainer")).toBe(false);
  });
});

describe("runBuildOrRollbackPipeline — idempotent retry", () => {
  test("createContainer เรียก removeContainer (ชื่อเดียวกัน) ก่อนเสมอ — กันชนกับ container ค้างจาก attempt ก่อน", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);
    const job = makeJob(projectId, deploymentId);
    const docker = mockDocker();

    const deps = baseDeps({ db, docker: docker as unknown as BuildPipelineDeps["docker"] });

    await runBuildOrRollbackPipeline(
      deps,
      job,
      {
        kind: "build",
        trigger: "manual",
        commitSha: "a".repeat(40),
        commitMessage: null,
        commitAuthor: null,
        source: { type: "github", installationId: 111, repoFullName: "org/repo" },
      },
      new AbortController().signal,
    );

    const removeIdx = docker.calls.findIndex((c) => c.method === "removeContainer");
    const createIdx = docker.calls.findIndex((c) => c.method === "createContainer");
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(removeIdx);
  });
});

describe("runBuildOrRollbackPipeline — rollback", () => {
  test("happy path: ข้าม cloning/building (timestamp เป็น null), verify image ก่อนแล้ว activate", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId, { commitSha: "c".repeat(40) });
    const job = makeJob(projectId, deploymentId);
    const docker = mockDocker({
      inspectImage: async () => ({
        Id: "sha256:target123",
        RepoDigests: ["sha256:target123"],
        Config: { Labels: null },
      }),
    });

    const deps = baseDeps({ db, docker: docker as unknown as BuildPipelineDeps["docker"] });

    const result = await runBuildOrRollbackPipeline(
      deps,
      job,
      {
        kind: "rollback",
        targetDeploymentId: "01JTARGET00000000000000000",
        imageTag: "zixploy/proj:old-dep",
        imageDigest: "sha256:target123",
      },
      new AbortController().signal,
    );

    expect(result.outcome).toBe("done");
    const deployment = db
      .query<{ status: string; cloning_at: number | null; building_at: number | null }, [string]>(
        "SELECT status, cloning_at, building_at FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(deployment?.status).toBe("succeeded");
    expect(deployment?.cloning_at).toBeNull();
    expect(deployment?.building_at).toBeNull();
  });

  test("image ไม่พบในเครื่อง → ROLLBACK_IMAGE_UNAVAILABLE", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);
    const job = makeJob(projectId, deploymentId);
    const docker = mockDocker({ inspectImage: async () => null });

    const deps = baseDeps({ db, docker: docker as unknown as BuildPipelineDeps["docker"] });

    const result = await runBuildOrRollbackPipeline(
      deps,
      job,
      {
        kind: "rollback",
        targetDeploymentId: "01JTARGET00000000000000000",
        imageTag: "zixploy/proj:deleted",
        imageDigest: "sha256:gone",
      },
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    const deployment = db
      .query<{ status: string; failure_code: string | null }, [string]>(
        "SELECT status, failure_code FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(deployment?.status).toBe("failed");
    expect(deployment?.failure_code).toBe("ROLLBACK_IMAGE_UNAVAILABLE");
  });

  test("digest ไม่ตรงกับที่บันทึกไว้ (image เสียหาย/rebuild ทับ) → ROLLBACK_IMAGE_UNAVAILABLE", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);
    const job = makeJob(projectId, deploymentId);
    const docker = mockDocker({
      inspectImage: async () => ({
        Id: "sha256:different",
        RepoDigests: [],
        Config: { Labels: null },
      }),
    });

    const deps = baseDeps({ db, docker: docker as unknown as BuildPipelineDeps["docker"] });

    const result = await runBuildOrRollbackPipeline(
      deps,
      job,
      {
        kind: "rollback",
        targetDeploymentId: "01JTARGET00000000000000000",
        imageTag: "zixploy/proj:tag",
        imageDigest: "sha256:expected",
      },
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    const deployment = db
      .query<{ failure_code: string | null }, [string]>(
        "SELECT failure_code FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(deployment?.failure_code).toBe("ROLLBACK_IMAGE_UNAVAILABLE");
  });
});

describe("runBuildOrRollbackPipeline — M7 hardening", () => {
  test("retention cleanup ถูกเรียกอัตโนมัติหลัง deploy สำเร็จ", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);
    const job = makeJob(projectId, deploymentId);
    const docker = mockDocker();

    const deps = baseDeps({ db, docker: docker as unknown as BuildPipelineDeps["docker"] });
    const result = await runBuildOrRollbackPipeline(
      deps,
      job,
      {
        kind: "build",
        trigger: "manual",
        commitSha: "a".repeat(40),
        commitMessage: null,
        commitAuthor: null,
        source: { type: "github", installationId: 111, repoFullName: "org/repo" },
      },
      new AbortController().signal,
    );

    expect(result.outcome).toBe("done");
    expect(docker.calls.some((c) => c.method === "listImagesByLabel")).toBe(true);
  });

  test("cleanup ที่ throw ไม่ทำให้ deploy ที่สำเร็จแล้วกลายเป็น failed", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);
    const job = makeJob(projectId, deploymentId);
    const docker = mockDocker({
      listImagesByLabel: async () => {
        throw new Error("docker images ล้มเหลวกลางทาง");
      },
    });

    const deps = baseDeps({ db, docker: docker as unknown as BuildPipelineDeps["docker"] });
    const result = await runBuildOrRollbackPipeline(
      deps,
      job,
      {
        kind: "build",
        trigger: "manual",
        commitSha: "a".repeat(40),
        commitMessage: null,
        commitAuthor: null,
        source: { type: "github", installationId: 111, repoFullName: "org/repo" },
      },
      new AbortController().signal,
    );

    expect(result.outcome).toBe("done");
    const deployment = db
      .query<{ status: string }, [string]>("SELECT status FROM deployments WHERE id = ?")
      .get(deploymentId);
    expect(deployment?.status).toBe("succeeded");
  });

  test("Docker daemon ไม่พร้อม (ping คืน false) ก่อนเข้า starting → DOCKER_UNAVAILABLE, ไม่พยายาม createContainer เลย", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId);
    const job = makeJob(projectId, deploymentId);
    const docker = mockDocker({ ping: async () => false });

    const deps = baseDeps({ db, docker: docker as unknown as BuildPipelineDeps["docker"] });
    const result = await runBuildOrRollbackPipeline(
      deps,
      job,
      {
        kind: "build",
        trigger: "manual",
        commitSha: "a".repeat(40),
        commitMessage: null,
        commitAuthor: null,
        source: { type: "github", installationId: 111, repoFullName: "org/repo" },
      },
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    const deployment = db
      .query<{ failure_code: string | null }, [string]>(
        "SELECT failure_code FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(deployment?.failure_code).toBe("DOCKER_UNAVAILABLE");
    expect(docker.calls.some((c) => c.method === "createContainer")).toBe(false);
  });

  test("pipeline เกิน deploy_timeout_sec → DEPLOY_TIMEOUT_EXCEEDED บดบัง error code ปลายทางที่ downstream โยนมา", async () => {
    const db = makeDb();
    const projectId = insertProject(db, { deployTimeoutSec: 1 });
    const deploymentId = insertDeployment(db, projectId);
    const job = makeJob(projectId, deploymentId);
    const docker = mockDocker();

    const deps = baseDeps({
      db,
      docker: docker as unknown as BuildPipelineDeps["docker"],
      // จำลอง downstream step ที่สังเกตเห็น signal abort แล้วโยน error ของตัวเอง (เหมือน buildImage
      // จริงตอน timeout — โยน error code เฉพาะของ step นั้น ไม่ใช่ DEPLOY_TIMEOUT_EXCEEDED)
      waitForHealthy: (params) =>
        new Promise((_resolve, reject) => {
          params.signal.addEventListener(
            "abort",
            () => reject(new AppError("HEALTH_CHECK_FAILED", "health check ถูกยกเลิกระหว่างทำงาน")),
            { once: true },
          );
        }),
    });

    const result = await runBuildOrRollbackPipeline(
      deps,
      job,
      {
        kind: "build",
        trigger: "manual",
        commitSha: "a".repeat(40),
        commitMessage: null,
        commitAuthor: null,
        source: { type: "github", installationId: 111, repoFullName: "org/repo" },
      },
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    const deployment = db
      .query<{ failure_code: string | null }, [string]>(
        "SELECT failure_code FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(deployment?.failure_code).toBe("DEPLOY_TIMEOUT_EXCEEDED");
  }, 5_000);
});
