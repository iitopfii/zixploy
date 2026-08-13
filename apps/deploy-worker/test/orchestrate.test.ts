/**
 * runComposePipeline tests — multi-container orchestrator (Phase 18 · Phase C2)
 *
 * mock ทุก dependency ภายนอกเหมือน pipeline-build.test.ts: Docker, clone, token mint, build,
 * health check — ไม่ต้องมี Docker/GitHub จริง แต่ createWorkspace/assertDockerfileWithinContext
 * เป็นของจริง (pure fs) จึงต้องเขียน Dockerfile จริงลง workspace ผ่าน fakeCloneCommit
 *
 * ครอบคลุม: เดินครบ state machine, build+pull classification, topological start order,
 * per-component health gating, partial-failure teardown (ลบใหม่ทั้งชุด ไม่แตะเก่า), managed_ref
 * verification, image-only compose (ไม่มี clone), per-deployment network + old-gen activation
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { AppError, serviceContainerName, ulid } from "@zixploy/shared";
import type { OrchestrateDeps } from "../src/pipeline/orchestrate";
import { runComposePipeline } from "../src/pipeline/orchestrate";
import type { ClaimedJob } from "../src/queue";

const testWorkspacesRoot = mkdtempSync(join(tmpdir(), "zixploy-orchestrate-test-"));
process.env.ZIXPLOY_WORKSPACES_DIR = testWorkspacesRoot;
afterEach(() => {
  try {
    rmSync(testWorkspacesRoot, { recursive: true, force: true });
  } catch {
    // Windows อาจปล่อย handle ช้า — ปล่อยให้ OS เก็บกวาด
  }
});

/** เขียน Dockerfile จริงลง destDir ให้ assertDockerfileWithinContext ผ่าน (build components ใช้ context '.') */
async function fakeCloneCommit(params: { destDir: string }): Promise<void> {
  writeFileSync(join(params.destDir, "Dockerfile"), "FROM scratch\n");
}

type Db = ReturnType<typeof openDatabase>;

function makeDb(): Db {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function insertComposeProject(db: Db, overrides: { deployTimeoutSec?: number } = {}): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO projects
      (id, name, status, mode, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'compose-test', 'new', 'compose', 'Dockerfile', '.', 'unless-stopped', ?, ?, ?)`,
  ).run(id, overrides.deployTimeoutSec ?? 900, now, now);
  return id;
}

interface ComponentInput {
  name: string;
  sourceKind: "build" | "image" | "managed_ref";
  isWeb?: boolean;
  webPort?: number | null;
  internalPort?: number | null;
  imageRef?: string | null;
  managedServiceId?: string | null;
  healthCmd?: string | null;
  position?: number;
}

function insertComponent(db: Db, projectId: string, c: ComponentInput): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO project_components
      (id, project_id, name, role, source_kind, dockerfile_path, build_context, image_ref,
       managed_service_id, internal_port, is_web, web_port, health_cmd, position, enabled, created_at, updated_at)
     VALUES (?, ?, ?, 'app', ?, ?, '.', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    projectId,
    c.name,
    c.sourceKind,
    c.sourceKind === "build" ? "Dockerfile" : null,
    c.imageRef ?? null,
    c.managedServiceId ?? null,
    c.internalPort ?? null,
    c.isWeb ? 1 : 0,
    c.webPort ?? null,
    c.healthCmd ?? null,
    c.position ?? 0,
    now,
    now,
  );
  return id;
}

function insertDep(
  db: Db,
  projectId: string,
  componentId: string,
  dependsOnId: string,
  condition: "started" | "healthy" = "started",
): void {
  db.query(
    `INSERT INTO component_deps (project_id, component_id, depends_on_component_id, condition)
     VALUES (?, ?, ?, ?)`,
  ).run(projectId, componentId, dependsOnId, condition);
}

/** managed service (0015) — inspectContainer จะถูก mock; ที่นี่แค่ต้องมี row ให้ FK ของ managed_ref ผ่าน */
function insertService(db: Db): string {
  const id = ulid();
  const suffix = id.slice(-8).toLowerCase();
  const now = Date.now();
  db.query(
    `INSERT INTO services
      (id, name, type, version, image, status, volume_name, username, database_name, internal_port, created_at, updated_at)
     VALUES (?, ?, 'postgres', '16', 'postgres:16-alpine', 'running', ?, 'app', 'app', 5432, ?, ?)`,
  ).run(id, `db-${suffix}`, `vol-${suffix}`, now, now);
  return id;
}

function insertDeployment(db: Db, projectId: string): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
     VALUES (?, ?, 'queued', 'manual', ?, ?, ?, ?)`,
  ).run(id, projectId, "a".repeat(40), now, now, now);
  return id;
}

/** generation เก่าที่ succeeded พร้อม deployment_containers — ใช้ทดสอบ activate/teardown */
function insertPrevGeneration(
  db: Db,
  projectId: string,
  containers: Array<{ componentId: string; containerId: string }>,
): string {
  const depId = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, finished_at, created_at, updated_at)
     VALUES (?, ?, 'succeeded', 'manual', ?, ?, ?, ?, ?)`,
  ).run(depId, projectId, "b".repeat(40), now, now, now, now);
  for (const c of containers) {
    db.query(
      `INSERT INTO deployment_containers (deployment_id, component_id, container_id, status, started_at)
       VALUES (?, ?, ?, 'running', ?)`,
    ).run(depId, c.componentId, c.containerId, now);
  }
  return depId;
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

interface MockCall {
  method: string;
  args: unknown[];
}

/** mock DockerCliClient — เฉพาะ method ที่ orchestrator เรียก; createContainer คืน cid ตามชื่อ alias */
function mockDocker(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: MockCall[] = [];
  const record =
    (method: string, impl: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return impl(...args);
    };

  const docker = {
    calls,
    ping: record("ping", async () => true),
    inspectContainer: record("inspectContainer", async () => ({
      Id: "svc",
      Name: "/svc",
      State: { Status: "running", Running: true },
      RestartCount: 0,
      NetworkSettings: { Networks: {} },
    })),
    ensureNetwork: record("ensureNetwork", async () => ({ networkId: "net1" })),
    removeNetwork: record("removeNetwork", async () => undefined),
    pullImage: record("pullImage", async () => undefined),
    removeContainer: record("removeContainer", async () => undefined),
    createContainer: record("createContainer", async (params: unknown) => {
      const p = params as { networkAliases?: string[]; name: string };
      return { containerId: `cid-${p.networkAliases?.[0] ?? p.name}` };
    }),
    connectNetwork: record("connectNetwork", async () => undefined),
    startContainer: record("startContainer", async () => undefined),
    stopContainer: record("stopContainer", async () => undefined),
    ...overrides,
  };
  return docker;
}

const GITHUB_PAYLOAD = {
  kind: "build" as const,
  trigger: "manual" as const,
  commitSha: "a".repeat(40),
  commitMessage: null,
  commitAuthor: null,
  source: { type: "github" as const, installationId: 111, repoFullName: "org/repo" },
};

function baseDeps(db: Db, docker: ReturnType<typeof mockDocker>): OrchestrateDeps {
  return {
    db,
    // biome-ignore lint/suspicious/noExplicitAny: mock docker — ไม่ implement ทุก method ของ interface จริง
    docker: docker as any,
    masterKeys: null,
    mintInstallationToken: async () => ({ token: "test-token", expiresAt: new Date() }),
    cloneCommit: fakeCloneCommit,
    buildImage: async () => ({ imageId: "sha256:abc", digest: "sha256:abc" }),
    waitForHealthy: async () => undefined,
    waitForContainerHealthy: async () => "healthy" as const,
    buildManagedRefEnv: async () => ({}),
    onLog: () => {},
    drainMs: 0,
  };
}

/** ชื่อ component จาก cid ที่ mock สร้าง (cid-<name>) — ใช้ assert ลำดับ start */
function startedNames(docker: ReturnType<typeof mockDocker>): string[] {
  return docker.calls
    .filter((c) => c.method === "startContainer")
    .map((c) => String(c.args[0]).replace(/^cid-/, ""));
}

describe("runComposePipeline — happy path", () => {
  test("เดินครบ state machine, build+pull, record ทุก container, container_id = web", async () => {
    const db = makeDb();
    const projectId = insertComposeProject(db);
    const web = insertComponent(db, projectId, {
      name: "web",
      sourceKind: "build",
      isWeb: true,
      webPort: 3000,
      position: 0,
    });
    const api = insertComponent(db, projectId, {
      name: "api",
      sourceKind: "build",
      internalPort: 4000,
      position: 1,
    });
    const cache = insertComponent(db, projectId, {
      name: "cache",
      sourceKind: "image",
      imageRef: "redis:7-alpine",
      internalPort: 6379,
      position: 2,
    });
    insertDep(db, projectId, api, cache, "healthy"); // api ต้องรอ cache healthy
    const deploymentId = insertDeployment(db, projectId);
    const docker = mockDocker();

    const builtTags: string[] = [];
    const deps = baseDeps(db, docker);
    deps.buildImage = async (p) => {
      builtTags.push(p.tag);
      return { imageId: "sha256:abc", digest: "sha256:abc" };
    };

    const result = await runComposePipeline(
      deps,
      makeJob(projectId, deploymentId),
      GITHUB_PAYLOAD,
      new AbortController().signal,
    );

    expect(result.outcome).toBe("done");

    const dep = db
      .query<
        {
          status: string;
          cloning_at: number | null;
          building_at: number | null;
          starting_at: number | null;
          health_checking_at: number | null;
          activating_at: number | null;
          container_id: string | null;
        },
        [string]
      >("SELECT * FROM deployments WHERE id = ?")
      .get(deploymentId);
    expect(dep?.status).toBe("succeeded");
    expect(dep?.cloning_at).not.toBeNull();
    expect(dep?.building_at).not.toBeNull();
    expect(dep?.starting_at).not.toBeNull();
    expect(dep?.health_checking_at).not.toBeNull();
    expect(dep?.activating_at).not.toBeNull();
    expect(dep?.container_id).toBe("cid-web");

    // build เรียก 2 ครั้ง (web + api), pull 1 ครั้ง (cache)
    expect(builtTags.length).toBe(2);
    expect(docker.calls.filter((c) => c.method === "pullImage").length).toBe(1);

    // deployment_containers บันทึกครบ 3 component
    const rows = db
      .query<{ component_id: string; container_id: string }, [string]>(
        "SELECT component_id, container_id FROM deployment_containers WHERE deployment_id = ?",
      )
      .all(deploymentId);
    expect(rows.length).toBe(3);
    const byComp = new Map(rows.map((r) => [r.component_id, r.container_id]));
    expect(byComp.get(web)).toBe("cid-web");
    expect(byComp.get(api)).toBe("cid-api");
    expect(byComp.get(cache)).toBe("cid-cache");
  });

  test("per-deployment network ถูกสร้าง + proxy ensured, web join proxy", async () => {
    const db = makeDb();
    const projectId = insertComposeProject(db);
    insertComponent(db, projectId, {
      name: "web",
      sourceKind: "build",
      isWeb: true,
      webPort: 3000,
    });
    const deploymentId = insertDeployment(db, projectId);
    const docker = mockDocker();

    await runComposePipeline(
      baseDeps(db, docker),
      makeJob(projectId, deploymentId),
      GITHUB_PAYLOAD,
      new AbortController().signal,
    );

    const ensured = docker.calls
      .filter((c) => c.method === "ensureNetwork")
      .map((c) => String(c.args[0]));
    expect(ensured.some((n) => n.startsWith("zx-dnet-"))).toBe(true); // per-deployment net
    expect(ensured).toContain("zixploy-proxy"); // PROXY_NETWORK

    // web ถูก connect เข้า proxy network เพิ่ม
    const connectProxy = docker.calls.find(
      (c) => c.method === "connectNetwork" && c.args[0] === "zixploy-proxy",
    );
    expect(connectProxy).toBeDefined();
    expect(connectProxy?.args[1]).toBe("cid-web");
  });
});

describe("runComposePipeline — topological start + health gating", () => {
  test("component ที่ depends_on start หลัง dependency ของมันเสมอ", async () => {
    const db = makeDb();
    const projectId = insertComposeProject(db);
    const web = insertComponent(db, projectId, {
      name: "web",
      sourceKind: "build",
      isWeb: true,
      webPort: 3000,
      position: 0,
    });
    const cache = insertComponent(db, projectId, {
      name: "cache",
      sourceKind: "image",
      imageRef: "redis:7-alpine",
      internalPort: 6379,
      position: 1,
    });
    insertDep(db, projectId, web, cache, "healthy"); // web ต้องรอ cache
    const deploymentId = insertDeployment(db, projectId);
    const docker = mockDocker();

    await runComposePipeline(
      baseDeps(db, docker),
      makeJob(projectId, deploymentId),
      GITHUB_PAYLOAD,
      new AbortController().signal,
    );

    const order = startedNames(docker);
    expect(order.indexOf("cache")).toBeLessThan(order.indexOf("web"));
  });

  test("health-gate เฉพาะ component ที่มี port (web=webPort, worker ไม่มี port ไม่ gate)", async () => {
    const db = makeDb();
    const projectId = insertComposeProject(db);
    insertComponent(db, projectId, {
      name: "web",
      sourceKind: "build",
      isWeb: true,
      webPort: 3000,
      position: 0,
    });
    // worker มี internalPort ตั้งไว้ แต่ non-web → worker เข้าไม่ถึง (อยู่ per-deployment net ล้วน)
    // จึงต้อง "ไม่" ถูก HTTP health-gate (กัน regression: เดิม gate ด้วย per-deployment net = fetch ไม่ถึง)
    insertComponent(db, projectId, {
      name: "worker",
      sourceKind: "build",
      internalPort: 9000,
      position: 1,
    });
    const deploymentId = insertDeployment(db, projectId);
    const docker = mockDocker();

    const probes: Array<{ port: number | null; network: string }> = [];
    const deps = baseDeps(db, docker);
    deps.waitForHealthy = async (p) => {
      probes.push({ port: p.internalPort, network: p.networkName });
    };

    await runComposePipeline(
      deps,
      makeJob(projectId, deploymentId),
      GITHUB_PAYLOAD,
      new AbortController().signal,
    );

    // gate เฉพาะ web (port 3000) เท่านั้น — worker (non-web) ถูกข้ามแม้มี internalPort
    expect(probes).toEqual([{ port: 3000, network: "zixploy-proxy" }]);
  });
});

describe("runComposePipeline — condition: healthy gating (Phase F)", () => {
  test("รอ dependency ให้ healthy ก่อน start ตัวที่ขึ้นกับมัน (start dep → wait healthy → start comp)", async () => {
    const db = makeDb();
    const projectId = insertComposeProject(db);
    const web = insertComponent(db, projectId, {
      name: "web",
      sourceKind: "build",
      isWeb: true,
      webPort: 3000,
      position: 0,
    });
    const cache = insertComponent(db, projectId, {
      name: "cache",
      sourceKind: "image",
      imageRef: "redis:7-alpine",
      healthCmd: "redis-cli ping",
      position: 1,
    });
    insertDep(db, projectId, web, cache, "healthy");
    const deploymentId = insertDeployment(db, projectId);

    const events: string[] = [];
    const docker = mockDocker({
      startContainer: async (id: unknown) => {
        events.push(`start:${String(id).replace("cid-", "")}`);
      },
    });
    const deps = baseDeps(db, docker);
    deps.waitForContainerHealthy = async (p) => {
      events.push(`wait:${String(p.containerId).replace("cid-", "")}`);
      return "healthy";
    };

    const result = await runComposePipeline(
      deps,
      makeJob(projectId, deploymentId),
      GITHUB_PAYLOAD,
      new AbortController().signal,
    );

    expect(result.outcome).toBe("done");
    // cache start ก่อน (topo) → web รอ cache healthy → web start
    expect(events).toEqual(["start:cache", "wait:cache", "start:web"]);
  });

  test("dependency แบบ managed_ref (healthy) → รอ health ของ service container", async () => {
    const db = makeDb();
    const projectId = insertComposeProject(db);
    const serviceId = insertService(db);
    const web = insertComponent(db, projectId, {
      name: "web",
      sourceKind: "build",
      isWeb: true,
      webPort: 3000,
      position: 0,
    });
    const dbComp = insertComponent(db, projectId, {
      name: "db",
      sourceKind: "managed_ref",
      managedServiceId: serviceId,
      position: 1,
    });
    insertDep(db, projectId, web, dbComp, "healthy");
    const deploymentId = insertDeployment(db, projectId);

    const docker = mockDocker();
    const waited: string[] = [];
    const deps = baseDeps(db, docker);
    deps.waitForContainerHealthy = async (p) => {
      waited.push(String(p.containerId));
      return "healthy";
    };

    await runComposePipeline(
      deps,
      makeJob(projectId, deploymentId),
      GITHUB_PAYLOAD,
      new AbortController().signal,
    );

    // gate รอ health ของ container ของ managed service (ไม่ใช่ container ที่สร้างใหม่)
    expect(waited).toEqual([serviceContainerName(serviceId)]);
  });

  test("component ที่ตั้ง healthCmd → createContainer ได้ Docker HEALTHCHECK (CMD-SHELL)", async () => {
    const db = makeDb();
    const projectId = insertComposeProject(db);
    insertComponent(db, projectId, {
      name: "web",
      sourceKind: "build",
      isWeb: true,
      webPort: 3000,
      position: 0,
    });
    insertComponent(db, projectId, {
      name: "cache",
      sourceKind: "image",
      imageRef: "redis:7-alpine",
      healthCmd: "redis-cli ping",
      position: 1,
    });
    const deploymentId = insertDeployment(db, projectId);
    const docker = mockDocker();

    await runComposePipeline(
      baseDeps(db, docker),
      makeJob(projectId, deploymentId),
      GITHUB_PAYLOAD,
      new AbortController().signal,
    );

    const cacheCreate = docker.calls.find(
      (c) =>
        c.method === "createContainer" &&
        (c.args[0] as { networkAliases?: string[] }).networkAliases?.[0] === "cache",
    );
    const params = cacheCreate?.args[0] as {
      healthCheck?: { cmd: string[]; intervalSec: number };
    };
    expect(params.healthCheck?.cmd).toEqual(["CMD-SHELL", "redis-cli ping"]);
  });

  test("dependency ไม่มี healthcheck → fallback เป็น started, deploy ยังสำเร็จ (ไม่ค้าง/fail)", async () => {
    const db = makeDb();
    const projectId = insertComposeProject(db);
    const web = insertComponent(db, projectId, {
      name: "web",
      sourceKind: "build",
      isWeb: true,
      webPort: 3000,
      position: 0,
    });
    // cache ไม่มี healthCmd → waitForContainerHealthy คืน "no-healthcheck"
    const cache = insertComponent(db, projectId, {
      name: "cache",
      sourceKind: "image",
      imageRef: "redis:7-alpine",
      position: 1,
    });
    insertDep(db, projectId, web, cache, "healthy");
    const deploymentId = insertDeployment(db, projectId);

    const docker = mockDocker();
    const deps = baseDeps(db, docker);
    deps.waitForContainerHealthy = async () => "no-healthcheck";

    const result = await runComposePipeline(
      deps,
      makeJob(projectId, deploymentId),
      GITHUB_PAYLOAD,
      new AbortController().signal,
    );

    expect(result.outcome).toBe("done");
  });
});

describe("runComposePipeline — managed_ref connection env (Phase F)", () => {
  test("component ที่ depends_on managed_ref → ฉีด connection env + join PROXY_NETWORK (แม้ไม่ใช่ web)", async () => {
    const db = makeDb();
    const projectId = insertComposeProject(db);
    const serviceId = insertService(db);
    const web = insertComponent(db, projectId, {
      name: "web",
      sourceKind: "build",
      isWeb: true,
      webPort: 3000,
      position: 0,
    });
    const worker = insertComponent(db, projectId, {
      name: "worker",
      sourceKind: "build",
      position: 1,
    });
    const dbComp = insertComponent(db, projectId, {
      name: "db",
      sourceKind: "managed_ref",
      managedServiceId: serviceId,
      position: 2,
    });
    insertDep(db, projectId, web, dbComp, "started");
    insertDep(db, projectId, worker, dbComp, "started");
    const deploymentId = insertDeployment(db, projectId);

    const docker = mockDocker();
    const deps = baseDeps(db, docker);
    // mock: จำลอง connection env ที่ buildManagedRefEnv จะสร้างจาก service (ตั้งชื่อตาม ref.name)
    deps.buildManagedRefEnv = async (_db, _mk, ref) => ({
      [`${ref.name.toUpperCase()}_URL`]: `postgresql://app@${serviceContainerName(serviceId)}:5432/app`,
    });

    const result = await runComposePipeline(
      deps,
      makeJob(projectId, deploymentId),
      GITHUB_PAYLOAD,
      new AbortController().signal,
    );

    expect(result.outcome).toBe("done");

    const envOf = (alias: string) => {
      const call = docker.calls.find(
        (c) =>
          c.method === "createContainer" &&
          (c.args[0] as { networkAliases?: string[] }).networkAliases?.[0] === alias,
      );
      return (call?.args[0] as { env?: Record<string, string> } | undefined)?.env ?? {};
    };
    // ทั้ง web และ worker ได้ DB_URL ฉีดเข้า env
    const expectedUrl = `postgresql://app@${serviceContainerName(serviceId)}:5432/app`;
    expect(envOf("web").DB_URL).toBe(expectedUrl);
    expect(envOf("worker").DB_URL).toBe(expectedUrl);

    // ทั้งคู่ join PROXY_NETWORK — worker (non-web) พิสูจน์ว่า needsProxy จาก managed_ref dep ทำงาน
    const proxyJoins = docker.calls
      .filter((c) => c.method === "connectNetwork" && c.args[0] === "zixploy-proxy")
      .map((c) => c.args[1]);
    expect(proxyJoins).toContain("cid-web");
    expect(proxyJoins).toContain("cid-worker");
  });

  test("component ที่ไม่พึ่ง managed_ref → ไม่เรียก buildManagedRefEnv, non-web ไม่ join proxy", async () => {
    const db = makeDb();
    const projectId = insertComposeProject(db);
    insertComponent(db, projectId, {
      name: "web",
      sourceKind: "build",
      isWeb: true,
      webPort: 3000,
      position: 0,
    });
    insertComponent(db, projectId, {
      name: "worker",
      sourceKind: "build",
      position: 1,
    });
    const deploymentId = insertDeployment(db, projectId);

    const docker = mockDocker();
    const deps = baseDeps(db, docker);
    let refEnvCalls = 0;
    deps.buildManagedRefEnv = async () => {
      refEnvCalls++;
      return {};
    };

    await runComposePipeline(
      deps,
      makeJob(projectId, deploymentId),
      GITHUB_PAYLOAD,
      new AbortController().signal,
    );

    expect(refEnvCalls).toBe(0);
    const proxyJoins = docker.calls
      .filter((c) => c.method === "connectNetwork" && c.args[0] === "zixploy-proxy")
      .map((c) => c.args[1]);
    expect(proxyJoins).toContain("cid-web"); // web join เสมอ
    expect(proxyJoins).not.toContain("cid-worker"); // worker ไม่พึ่ง managed_ref → ไม่ join
  });
});

describe("runComposePipeline — managed_ref", () => {
  test("service ที่อ้างถึงไม่รันอยู่ → SERVICE_PROVISION_FAILED, ไม่สร้าง container", async () => {
    const db = makeDb();
    const projectId = insertComposeProject(db);
    const serviceId = insertService(db);
    insertComponent(db, projectId, {
      name: "web",
      sourceKind: "build",
      isWeb: true,
      webPort: 3000,
    });
    insertComponent(db, projectId, {
      name: "db",
      sourceKind: "managed_ref",
      managedServiceId: serviceId,
    });
    const deploymentId = insertDeployment(db, projectId);
    const docker = mockDocker({
      inspectContainer: async () => ({
        Id: "svc",
        Name: "/svc",
        State: { Status: "exited", Running: false },
        RestartCount: 0,
        NetworkSettings: { Networks: {} },
      }),
    });

    const result = await runComposePipeline(
      baseDeps(db, docker),
      makeJob(projectId, deploymentId),
      GITHUB_PAYLOAD,
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    const dep = db
      .query<{ failure_code: string | null }, [string]>(
        "SELECT failure_code FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(dep?.failure_code).toBe("SERVICE_PROVISION_FAILED");
    expect(docker.calls.some((c) => c.method === "createContainer")).toBe(false);
  });

  test("web depends_on managed_ref (running) → topo ไม่ throw, managed_ref ไม่ถูก start, deploy สำเร็จ", async () => {
    const db = makeDb();
    const projectId = insertComposeProject(db);
    const serviceId = insertService(db);
    const web = insertComponent(db, projectId, {
      name: "web",
      sourceKind: "build",
      isWeb: true,
      webPort: 3000,
      position: 0,
    });
    const dbComp = insertComponent(db, projectId, {
      name: "db",
      sourceKind: "managed_ref",
      managedServiceId: serviceId,
      position: 1,
    });
    insertDep(db, projectId, web, dbComp, "healthy"); // web อ้าง db (managed_ref)
    const deploymentId = insertDeployment(db, projectId);
    const docker = mockDocker();

    const result = await runComposePipeline(
      baseDeps(db, docker),
      makeJob(projectId, deploymentId),
      GITHUB_PAYLOAD,
      new AbortController().signal,
    );

    expect(result.outcome).toBe("done");
    // managed_ref ไม่ถูกสร้าง/start เป็น container ใหม่ — start เฉพาะ web
    expect(startedNames(docker)).toEqual(["web"]);
    // deployment_containers บันทึกเฉพาะ web (managed_ref ไม่ถูก record)
    const rows = db
      .query<{ component_id: string }, [string]>(
        "SELECT component_id FROM deployment_containers WHERE deployment_id = ?",
      )
      .all(deploymentId);
    expect(rows.map((r) => r.component_id)).toEqual([web]);
  });
});

describe("runComposePipeline — image-only compose (ไม่มี build component)", () => {
  test("ไม่มี clone/mint token, pull อย่างเดียว, เดินครบ state จน succeeded", async () => {
    const db = makeDb();
    const projectId = insertComposeProject(db);
    insertComponent(db, projectId, {
      name: "web",
      sourceKind: "image",
      imageRef: "nginx:1.27-alpine",
      isWeb: true,
      webPort: 80,
    });
    const deploymentId = insertDeployment(db, projectId);
    const docker = mockDocker();

    let cloneCalled = false;
    let mintCalled = false;
    const deps = baseDeps(db, docker);
    deps.cloneCommit = async () => {
      cloneCalled = true;
    };
    deps.mintInstallationToken = async () => {
      mintCalled = true;
      return { token: "x", expiresAt: new Date() };
    };

    const result = await runComposePipeline(
      deps,
      makeJob(projectId, deploymentId),
      GITHUB_PAYLOAD,
      new AbortController().signal,
    );

    expect(result.outcome).toBe("done");
    expect(cloneCalled).toBe(false);
    expect(mintCalled).toBe(false);
    expect(docker.calls.filter((c) => c.method === "pullImage").length).toBe(1);
    const dep = db
      .query<{ status: string; cloning_at: number | null }, [string]>(
        "SELECT status, cloning_at FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(dep?.status).toBe("succeeded");
    expect(dep?.cloning_at).not.toBeNull(); // ผ่าน state cloning แม้ไม่มีอะไร clone
  });
});

describe("runComposePipeline — partial-failure teardown (ADR-0004)", () => {
  test("health check ตัวหนึ่งล้ม → ลบ container ใหม่ทั้งชุด + network ใหม่, ของเก่าไม่ถูกแตะ", async () => {
    const db = makeDb();
    const projectId = insertComposeProject(db);
    const web = insertComponent(db, projectId, {
      name: "web",
      sourceKind: "build",
      isWeb: true,
      webPort: 3000,
      position: 0,
    });
    const cache = insertComponent(db, projectId, {
      name: "cache",
      sourceKind: "image",
      imageRef: "redis:7-alpine",
      internalPort: 6379,
      position: 1,
    });
    // generation เก่าที่ succeeded — ต้องไม่ถูกแตะเมื่อ deploy ใหม่ล้ม
    insertPrevGeneration(db, projectId, [
      { componentId: web, containerId: "old-web" },
      { componentId: cache, containerId: "old-cache" },
    ]);
    const deploymentId = insertDeployment(db, projectId);
    const docker = mockDocker();

    const deps = baseDeps(db, docker);
    deps.waitForHealthy = async () => {
      throw new AppError("HEALTH_CHECK_FAILED", "health check ไม่ผ่าน");
    };

    const result = await runComposePipeline(
      deps,
      makeJob(projectId, deploymentId),
      GITHUB_PAYLOAD,
      new AbortController().signal,
    );

    expect(result.outcome).toBe("failed");
    const dep = db
      .query<{ status: string; failure_code: string | null }, [string]>(
        "SELECT status, failure_code FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(dep?.status).toBe("failed");
    expect(dep?.failure_code).toBe("HEALTH_CHECK_FAILED");

    // ของเก่าไม่ถูก stop/remove เลย (ADR-0004 หลัก)
    const touchedOld = docker.calls.some(
      (c) =>
        (c.method === "stopContainer" || c.method === "removeContainer") &&
        (c.args[0] === "old-web" || c.args[0] === "old-cache"),
    );
    expect(touchedOld).toBe(false);

    // network ใหม่ (per-deployment) ถูกลบใน teardown
    const removedNewNet = docker.calls.some(
      (c) => c.method === "removeNetwork" && String(c.args[0]).startsWith("zx-dnet-"),
    );
    expect(removedNewNet).toBe(true);
  });
});

describe("runComposePipeline — activate over old generation", () => {
  test("deploy สำเร็จ → หยุด+ลบ container เก่าทั้งชุด และลบ network เก่า", async () => {
    const db = makeDb();
    const projectId = insertComposeProject(db);
    const web = insertComponent(db, projectId, {
      name: "web",
      sourceKind: "build",
      isWeb: true,
      webPort: 3000,
    });
    const prevDepId = insertPrevGeneration(db, projectId, [
      { componentId: web, containerId: "old-web" },
    ]);
    const deploymentId = insertDeployment(db, projectId);
    const docker = mockDocker();

    const result = await runComposePipeline(
      baseDeps(db, docker),
      makeJob(projectId, deploymentId),
      GITHUB_PAYLOAD,
      new AbortController().signal,
    );

    expect(result.outcome).toBe("done");
    // ของเก่าถูกหยุด + ลบ
    expect(docker.calls.some((c) => c.method === "stopContainer" && c.args[0] === "old-web")).toBe(
      true,
    );
    expect(
      docker.calls.some((c) => c.method === "removeContainer" && c.args[0] === "old-web"),
    ).toBe(true);
    // network ของ generation เก่าถูกลบ (ชื่อ deterministic จาก prevDepId)
    const removedOldNet = docker.calls.some(
      (c) => c.method === "removeNetwork" && String(c.args[0]).includes(prevDepId.toLowerCase()),
    );
    expect(removedOldNet).toBe(true);
  });
});
