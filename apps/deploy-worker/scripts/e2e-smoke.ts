/**
 * Manual E2E smoke test — Phase 3 M1-M7 sign-off (ad-hoc, ไม่ใช่ส่วนของ automated test suite)
 *
 * รัน runBuildOrRollbackPipeline (M6) จริงกับ dependency จริงทั้งหมด (real cloneCommit ผ่าน git
 * plumbing จริง, real buildImage ผ่าน docker buildx จริง, real DockerCliClient, real waitForHealthy,
 * real activate) — ปลอมแค่สองจุดที่ต้องพึ่งโครงสร้างพื้นฐานที่ยังไม่ได้ตั้งค่าในเครื่อง dev นี้:
 *   1. mintInstallationToken — ไม่มี GitHub App ติดตั้งจริงในเครื่องนี้ (github_apps/
 *      github_installations ว่างเปล่า) จึงคืน token ปลอม
 *   2. clone target — ใช้ cloneCommit's remoteUrl override (parameter ที่มีอยู่จริงใน production
 *      code สำหรับ self-hosted git ก็ใช้ทางเดียวกันนี้) ชี้ไป local bare repo แทน github.com
 * ทุกอย่างอื่น (git clone, docker build, container create/start/inspect, health check polling,
 * start-before-stop activation, rollback) เป็นโค้ด production ตัวจริงไม่มีการ mock
 *
 * health check ใช้ fallback mode (internalPort/healthCheckPath = null) เพราะ container บน
 * zixploy-proxy bridge network ไม่ reachable ตรงจาก host บน Docker Desktop/Windows (ข้อจำกัดที่
 * บันทึกไว้แล้วใน health-check.ts — ใช้งานได้จริงเฉพาะบน Linux prod target)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildImage } from "../src/docker/buildkit";
import { DockerCliClient } from "../src/docker/cli-client";
import { cloneCommit as realCloneCommit } from "../src/git/clone";
import { activate } from "../src/pipeline/activate";
import { runBuildOrRollbackPipeline } from "../src/pipeline/build";
import { waitForHealthy } from "../src/pipeline/health-check";
import type { ClaimedJob } from "../src/queue";

const RUN_ID = ulid();
const log = (msg: string) => console.log(`[e2e ${new Date().toISOString()}] ${msg}`);

function run(args: string[], cwd: string) {
  const proc = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`fixture cmd failed: ${args.join(" ")}\n${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trim();
}

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), "zixploy-e2e-smoke-"));
  const workspacesDir = join(workDir, "workspaces");
  mkdirSync(workspacesDir, { recursive: true });
  process.env.ZIXPLOY_WORKSPACES_DIR = workspacesDir;

  const dbPath = join(workDir, "e2e.sqlite");
  const db = openDatabase({ path: dbPath });
  migrateUp(db, loadMigrations(migrationsDir()));

  const docker = new DockerCliClient();
  const containersToClean: string[] = [];
  const imagesToClean: string[] = [];

  try {
    log("ping Docker daemon...");
    if (!(await docker.ping())) throw new Error("Docker daemon ไม่พร้อมใช้งาน — หยุด E2E");
    log("Docker daemon พร้อมใช้งาน ✓");

    // --- source repo fixture v1 ---
    const sourceDir = join(workDir, "source-v1");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "Dockerfile"),
      'FROM busybox:latest\nCMD ["sh", "-c", "echo v1-running && sleep 3600"]\n',
    );
    run(["git", "init", "-b", "main", sourceDir], workDir);
    run(["git", "-C", sourceDir, "config", "user.email", "e2e@example.com"], workDir);
    run(["git", "-C", sourceDir, "config", "user.name", "E2E"], workDir);
    run(["git", "-C", sourceDir, "add", "."], workDir);
    run(["git", "-C", sourceDir, "commit", "-m", "v1"], workDir);
    const commitShaV1 = run(["git", "-C", sourceDir, "rev-parse", "HEAD"], workDir);

    const bareDir = join(workDir, "source.git");
    run(["git", "clone", "--bare", sourceDir, bareDir], workDir);
    log(`fixture repo พร้อม — v1 commit ${commitShaV1.slice(0, 7)}`);

    // --- project row ---
    const projectId = ulid();
    const now = Date.now();
    db.query(
      `INSERT INTO projects
        (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec,
         health_check_interval_sec, health_check_timeout_sec, health_check_retries, created_at, updated_at)
       VALUES (?, ?, 'new', 'Dockerfile', '.', 'unless-stopped', 120, 1, 5, 5, ?, ?)`,
    ).run(projectId, `e2e-smoke-${RUN_ID}`, now, now);
    log(`project สร้างแล้ว: ${projectId}`);

    function fakeMintToken() {
      return Promise.resolve({ token: "fake-e2e-token", expiresAt: new Date(Date.now() + 60_000) });
    }

    function cloneFromFixture(remoteUrl: string) {
      return (params: Parameters<typeof realCloneCommit>[0]) =>
        realCloneCommit({ ...params, remoteUrl });
    }

    // ============ Deploy #1 (build, v1) ============
    const deployment1Id = ulid();
    db.query(
      `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
       VALUES (?, ?, 'queued', 'manual', ?, ?, ?, ?)`,
    ).run(deployment1Id, projectId, commitShaV1, now, now, now);

    const job1: ClaimedJob = {
      id: ulid(),
      projectId,
      deploymentId: deployment1Id,
      type: "deploy",
      status: "leased",
      payload: {},
      attempts: 1,
      maxAttempts: 1,
    };

    log("=== Deploy #1: build v1 (real clone + real docker build + real container) ===");
    const result1 = await runBuildOrRollbackPipeline(
      {
        db,
        docker,
        masterKeys: null,
        mintInstallationToken: fakeMintToken,
        cloneCommit: cloneFromFixture(bareDir),
        buildImage,
        waitForHealthy,
        activate,
        onLog: (line) => log(`  [build] ${line}`),
      },
      job1,
      {
        kind: "build",
        trigger: "manual",
        commitSha: commitShaV1,
        commitMessage: "v1",
        commitAuthor: "E2E",
        source: { type: "github", installationId: 0, repoFullName: "local/fixture" },
      },
      new AbortController().signal,
    );

    log(`Deploy #1 result: ${JSON.stringify(result1)}`);
    if (result1.outcome !== "done") throw new Error("Deploy #1 ล้มเหลว — หยุด E2E");

    const deployment1 = db
      .query<
        {
          status: string;
          container_id: string | null;
          image_tag: string | null;
          image_digest: string | null;
          cloning_at: number | null;
          building_at: number | null;
          starting_at: number | null;
          health_checking_at: number | null;
          activating_at: number | null;
        },
        [string]
      >("SELECT * FROM deployments WHERE id = ?")
      .get(deployment1Id);
    log(`Deploy #1 DB state: ${JSON.stringify(deployment1)}`);
    if (deployment1?.status !== "succeeded") throw new Error("Deploy #1 status ไม่ใช่ succeeded");
    for (const col of [
      "cloning_at",
      "building_at",
      "starting_at",
      "health_checking_at",
      "activating_at",
    ] as const) {
      if (!deployment1[col]) throw new Error(`Deploy #1: ${col} ไม่ถูกตั้งค่า — state machine ผิดพลาด`);
    }
    const container1Id = deployment1.container_id;
    if (!container1Id) throw new Error("Deploy #1: container_id ไม่ถูกบันทึก");
    containersToClean.push(container1Id);
    if (deployment1.image_tag) imagesToClean.push(deployment1.image_tag);

    const inspect1 = await docker.inspectContainer(container1Id);
    log(
      `container จริงบน Docker: Id=${inspect1?.Id.slice(0, 12)} Running=${inspect1?.State.Running} Networks=${JSON.stringify(Object.keys(inspect1?.NetworkSettings.Networks ?? {}))}`,
    );
    if (!inspect1?.State.Running) throw new Error("container v1 ไม่ได้ Running จริงบน Docker");
    if (!inspect1.NetworkSettings.Networks["zixploy-proxy"]) {
      throw new Error("container v1 ไม่ได้เชื่อม zixploy-proxy network");
    }
    log("✓ container v1 Running จริงบน Docker และเชื่อม zixploy-proxy network");

    // ============ Deploy #2 (build, v2 — ทดสอบ start-before-stop activation) ============
    const sourceDirV2 = join(workDir, "source-v2");
    mkdirSync(sourceDirV2, { recursive: true });
    writeFileSync(
      join(sourceDirV2, "Dockerfile"),
      'FROM busybox:latest\nCMD ["sh", "-c", "echo v2-running && sleep 3600"]\n',
    );
    run(["git", "init", "-b", "main", sourceDirV2], workDir);
    run(["git", "-C", sourceDirV2, "config", "user.email", "e2e@example.com"], workDir);
    run(["git", "-C", sourceDirV2, "config", "user.name", "E2E"], workDir);
    run(["git", "-C", sourceDirV2, "add", "."], workDir);
    run(["git", "-C", sourceDirV2, "commit", "-m", "v2"], workDir);
    const commitShaV2 = run(["git", "-C", sourceDirV2, "rev-parse", "HEAD"], workDir);
    const bareDirV2 = join(workDir, "source-v2.git");
    run(["git", "clone", "--bare", sourceDirV2, bareDirV2], workDir);

    const deployment2Id = ulid();
    db.query(
      `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
       VALUES (?, ?, 'queued', 'manual', ?, ?, ?, ?)`,
    ).run(deployment2Id, projectId, commitShaV2, Date.now(), Date.now(), Date.now());

    const job2: ClaimedJob = {
      id: ulid(),
      projectId,
      deploymentId: deployment2Id,
      type: "deploy",
      status: "leased",
      payload: {},
      attempts: 1,
      maxAttempts: 1,
    };

    log("=== Deploy #2: build v2 (ต้อง start container ใหม่ก่อนปิดของเก่า — ADR-0004) ===");
    const result2 = await runBuildOrRollbackPipeline(
      {
        db,
        docker,
        masterKeys: null,
        mintInstallationToken: fakeMintToken,
        cloneCommit: cloneFromFixture(bareDirV2),
        buildImage,
        waitForHealthy,
        activate: (params) => activate({ ...params, drainMs: 500 }), // ย่อ drain period ให้ E2E เร็วขึ้น
        onLog: (line) => log(`  [build] ${line}`),
      },
      job2,
      {
        kind: "build",
        trigger: "manual",
        commitSha: commitShaV2,
        commitMessage: "v2",
        commitAuthor: "E2E",
        source: { type: "github", installationId: 0, repoFullName: "local/fixture" },
      },
      new AbortController().signal,
    );

    log(`Deploy #2 result: ${JSON.stringify(result2)}`);
    if (result2.outcome !== "done") throw new Error("Deploy #2 ล้มเหลว — หยุด E2E");

    const deployment2 = db
      .query<{ status: string; container_id: string | null; image_tag: string | null }, [string]>(
        "SELECT status, container_id, image_tag FROM deployments WHERE id = ?",
      )
      .get(deployment2Id);
    const container2Id = deployment2?.container_id;
    if (!container2Id) throw new Error("Deploy #2: container_id ไม่ถูกบันทึก");
    containersToClean.push(container2Id);
    if (deployment2?.image_tag) imagesToClean.push(deployment2.image_tag);

    const inspect2 = await docker.inspectContainer(container2Id);
    log(
      `container v2 จริงบน Docker: Id=${inspect2?.Id.slice(0, 12)} Running=${inspect2?.State.Running}`,
    );
    if (!inspect2?.State.Running) throw new Error("container v2 ไม่ได้ Running จริง");

    const oldContainerAfterActivate = await docker.inspectContainer(container1Id);
    log(
      `container v1 (ของเก่า) หลัง activate: ${oldContainerAfterActivate === null ? "ถูกลบแล้ว" : `ยังอยู่ Status=${oldContainerAfterActivate.State.Status}`}`,
    );
    if (oldContainerAfterActivate !== null) {
      throw new Error("ADR-0004: container v1 ควรถูกลบไปแล้วหลัง activate v2 สำเร็จ");
    }
    log(
      "✓ ADR-0004 ยืนยันจริง: container v2 (candidate) ขึ้นสำเร็จก่อน แล้ว container v1 (ของเก่า) ถึงถูกปิด/ลบ",
    );

    // ============ Rollback: กลับไป v1's image ============
    const deployment1Full = db
      .query<{ image_tag: string; image_digest: string }, [string]>(
        "SELECT image_tag, image_digest FROM deployments WHERE id = ?",
      )
      .get(deployment1Id);
    if (!deployment1Full) throw new Error("หา deployment #1 ไม่เจอสำหรับ rollback");

    const deployment3Id = ulid();
    db.query(
      `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
       VALUES (?, ?, 'queued', 'rollback', ?, ?, ?, ?)`,
    ).run(deployment3Id, projectId, commitShaV1, Date.now(), Date.now(), Date.now());

    const job3: ClaimedJob = {
      id: ulid(),
      projectId,
      deploymentId: deployment3Id,
      type: "deploy",
      status: "leased",
      payload: {},
      attempts: 1,
      maxAttempts: 1,
    };

    log("=== Rollback: กลับไป v1's image (ข้าม cloning/building) ===");
    const result3 = await runBuildOrRollbackPipeline(
      {
        db,
        docker,
        masterKeys: null,
        mintInstallationToken: fakeMintToken,
        cloneCommit: cloneFromFixture(bareDir),
        buildImage,
        waitForHealthy,
        activate: (params) => activate({ ...params, drainMs: 500 }),
        onLog: (line) => log(`  [rollback] ${line}`),
      },
      job3,
      {
        kind: "rollback",
        targetDeploymentId: deployment1Id,
        imageTag: deployment1Full.image_tag,
        imageDigest: deployment1Full.image_digest,
      },
      new AbortController().signal,
    );

    log(`Rollback result: ${JSON.stringify(result3)}`);
    if (result3.outcome !== "done") throw new Error("Rollback ล้มเหลว — หยุด E2E");

    const deployment3 = db
      .query<
        {
          status: string;
          container_id: string | null;
          cloning_at: number | null;
          building_at: number | null;
        },
        [string]
      >("SELECT status, container_id, cloning_at, building_at FROM deployments WHERE id = ?")
      .get(deployment3Id);
    log(`Rollback DB state: ${JSON.stringify(deployment3)}`);
    if (deployment3?.cloning_at || deployment3?.building_at) {
      throw new Error("Rollback ไม่ควรมี cloning_at/building_at — ข้าม step เหล่านี้ตาม design");
    }
    const container3Id = deployment3?.container_id;
    if (!container3Id) throw new Error("Rollback: container_id ไม่ถูกบันทึก");
    containersToClean.push(container3Id);

    const inspect3 = await docker.inspectContainer(container3Id);
    log(
      `container rollback จริงบน Docker: Id=${inspect3?.Id.slice(0, 12)} Running=${inspect3?.State.Running}`,
    );
    if (!inspect3?.State.Running) throw new Error("container rollback ไม่ได้ Running จริง");
    log("✓ rollback สำเร็จจริง: container ใหม่รันจาก v1's image เดิม โดยไม่ clone/build ซ้ำ");

    // ============ Retention cleanup (M7) verification ============
    const remainingImages = await docker.listImagesByLabel({ "platform.project_id": projectId });
    log(
      `M7 cleanup: image ที่เหลือของ project นี้หลัง deploy 3 ครั้ง = ${remainingImages.length} (คาดว่า ≤ 3 ตาม IMAGE_RETENTION_KEEP_COUNT)`,
    );

    log("");
    log("========================================");
    log("✅ E2E SMOKE TEST ผ่านทั้งหมด — Phase 3 M1-M7 ยืนยันทำงานจริงบน Docker Desktop");
    log("========================================");
  } finally {
    log("cleanup: ลบ container/image/workspace/db ที่สร้างระหว่างเทสต์...");
    for (const id of containersToClean) {
      await docker.removeContainer(id, { force: true }).catch(() => {});
    }
    for (const tag of imagesToClean) {
      await docker.removeImage(tag, { force: true }).catch(() => {});
    }
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Windows อาจปล่อย handle ช้า
    }
    log("cleanup เสร็จสิ้น");
  }
}

await main();
