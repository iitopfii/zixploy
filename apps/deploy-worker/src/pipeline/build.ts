/**
 * Build/rollback pipeline — เดินตาม deployment state machine (@zixploy/shared):
 * queued → cloning → building → starting → health_checking → activating → succeeded
 *                                        ↘ failed (ทุก step ก่อนหน้า succeeded)
 *
 * เขียน DB status ก่อนเริ่ม side effect เสมอ (ดู db/deployment-state.ts) — worker ตายกลางทาง
 * DB จะบอกว่า "กำลังพยายามทำ X" ให้ recovery รู้ว่าค้างอยู่ขั้นไหน
 *
 * ทุก dependency ภายนอก (docker, clone, mint token, build, health check, activate) ฉีดเข้ามา
 * เป็นพารามิเตอร์ทั้งหมด ไม่ import ตรง ๆ — เพื่อ mock ได้เต็มรูปแบบในเทสต์โดยไม่ต้องมี Docker/GitHub จริง
 */

import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppError,
  BUILD_SANDBOX_LIMITS,
  buildTraefikLabels,
  containerName,
  deploymentLabels,
  imageName,
  isTerminal,
  PROXY_NETWORK,
} from "@zixploy/shared";
import {
  failDeployment,
  getDeploymentStatus,
  transitionDeployment,
  transitionToStartingForRollback,
} from "../db/deployment-state";
import { findActiveContainerId, loadProjectConfig, setProjectStatus } from "../db/project-config";
import type { BuildImageParams, BuildImageResult, BuildSecret } from "../docker/buildkit";
import type { DockerCliClient } from "../docker/cli-client";
import { loadProjectDomains } from "../domains/loader";
import { injectEnvVars } from "../env/inject";
import { buildRedactFn } from "../env/redaction";
import type { CloneParams } from "../git/clone";
import type { MasterKeys } from "../github/master-key";
import type { MintedToken } from "../github/token";
import { pruneBuildLogs } from "../logs/retention";
import type { ClaimedJob } from "../queue";
import { loadActiveVolumes } from "../volumes/loader";
import {
  assertDockerfileWithinContext,
  assertWorkspaceSizeWithinLimit,
  createWorkspace,
  removeWorkspace,
} from "../workspace";
import type { ActivateParams } from "./activate";
import { cleanupProjectImages } from "./cleanup";
import type { HealthCheckParams } from "./health-check";
import type { DeployJobPayload } from "./payload";
import { createDeployTimeout } from "./timeout";

export interface BuildPipelineDeps {
  db: Database;
  docker: DockerCliClient;
  masterKeys: MasterKeys | null;
  mintInstallationToken: (
    db: Database,
    masterKeys: MasterKeys | null,
    installationId: number,
  ) => Promise<MintedToken>;
  cloneCommit: (params: CloneParams) => Promise<void>;
  buildImage: (params: BuildImageParams) => Promise<BuildImageResult>;
  waitForHealthy: (params: HealthCheckParams) => Promise<void>;
  activate: (params: ActivateParams) => Promise<void>;
  onLog: (line: string) => void;
}

type BuildOrRollbackPayload = Extract<DeployJobPayload, { kind: "build" | "rollback" }>;

/** สัดส่วน timeout budget รวมของ deploy_timeout_sec — clone/build ใช้ร่วมกันจาก budget เดียว */
function splitTimeoutBudget(deployTimeoutSec: number): { cloneMs: number; buildMs: number } {
  const totalMs = deployTimeoutSec * 1000;
  return { cloneMs: Math.floor(totalMs * 0.3), buildMs: Math.floor(totalMs * 0.7) };
}

export async function runBuildOrRollbackPipeline(
  deps: BuildPipelineDeps,
  job: ClaimedJob,
  payload: BuildOrRollbackPayload,
  signal: AbortSignal,
): Promise<{ outcome: "done" } | { outcome: "failed"; retryable: false }> {
  const { db } = deps;
  const deploymentId = job.deploymentId;
  if (!deploymentId) {
    // ไม่ควรเกิดจริง — control-api สร้าง build/rollback job พร้อม deployment เสมอ (deploys/queue.ts)
    return { outcome: "failed", retryable: false };
  }

  const project = loadProjectConfig(db, job.projectId);
  if (!project) {
    failDeployment(db, deploymentId, "WORKSPACE_ERROR", "ไม่พบ project configuration ใน DB");
    return { outcome: "failed", retryable: false };
  }

  const cName = containerName(job.projectId, deploymentId);

  // ครอบทั้ง pipeline ด้วย deploy_timeout_sec แยกจาก lease/cancel signal ที่รับมา (timeout.ts) —
  // ต้อง cleanup() เสมอไม่ว่าจบแบบไหน กัน timer ค้าง/leak
  const deployTimeout = createDeployTimeout(signal, project.deployTimeoutSec * 1000);

  // exposed port (Phase 14): container เก่าถือ host port อยู่ — candidate จะ start ไม่ขึ้นจนกว่า
  // จะหยุดของเก่าก่อน จำ id ไว้เพื่อ restart คืนถ้า candidate ล้มเหลว (ลด downtime จาก failure)
  let stoppedOldForPort: string | null = null;

  try {
    let imageTag: string;
    let imageDigest: string;

    // Decrypt env vars ก่อน — ใช้ทั้งฝั่ง build (buildArgs/secrets) และ starting (runtimeEnv)
    // masterKeys=null → empty injection (graceful — deploy ดำเนินต่อได้โดยไม่มี env)
    const envInject = await injectEnvVars(db, deps.masterKeys, job.projectId, deps.onLog);

    // Wrap onLog ด้วย centralized redact function ทันทีหลังได้ secretValues
    // — buildkit.ts ไม่ redact เอง (ดู comment ในไฟล์นั้น) pipeline ต้องทำเอง
    const redactFn = buildRedactFn(envInject.secretValues);
    const safeLog = (line: string) => deps.onLog(redactFn(line));

    if (payload.kind === "build") {
      const { cloneMs, buildMs } = splitTimeoutBudget(project.deployTimeoutSec);

      // --- cloning ---
      transitionDeployment(db, deploymentId, "cloning");
      const { workspaceDir, buildContextDir } = createWorkspace(deploymentId, project.buildContext);

      // temp dir สำหรับ build secrets — ลบใน finally เสมอ
      let secretDir: string | null = null;

      try {
        if (payload.source.type === "github") {
          const token = await deps.mintInstallationToken(
            db,
            deps.masterKeys,
            payload.source.installationId,
          );
          await deps.cloneCommit({
            repoFullName: payload.source.repoFullName,
            commitSha: payload.commitSha,
            token: token.token,
            destDir: workspaceDir,
            timeoutMs: cloneMs,
            signal: deployTimeout.signal,
            onLog: safeLog,
          });
        } else {
          // dockerfile-paste source (Phase 13) — ไม่มี git clone เลย เขียนเนื้อหาที่ผู้ใช้วางเอง
          // ลง buildContextDir ตรง ๆ; dockerfilePath ถูกบังคับเป็น 'Dockerfile' และ buildContext
          // เป็น '.' ตอนตั้ง source (control-api/routes/dockerfile-source.ts) — ไม่มีไฟล์อื่นอยู่ร่วม
          mkdirSync(buildContextDir, { recursive: true });
          writeFileSync(
            join(buildContextDir, project.dockerfilePath),
            payload.source.dockerfileContent,
            { mode: 0o600 },
          );
          safeLog("[workspace] ใช้ Dockerfile ที่วางไว้ใน source โดยตรง (ไม่มี git clone)");
        }
        // ตรวจหลัง clone/เขียนไฟล์เสร็จเท่านั้น (ต้องมี buildContextDir อยู่จริงก่อนถึงจะ realpath ได้)
        assertDockerfileWithinContext(buildContextDir, project.dockerfilePath);
        // ตรวจขนาด workspace ก่อนเริ่ม build เสมอ (Phase 8 M1 — threat-model.md)
        assertWorkspaceSizeWithinLimit(workspaceDir, BUILD_SANDBOX_LIMITS.workspaceMaxMb);

        // --- building ---
        transitionDeployment(db, deploymentId, "building");
        const tag = imageName(job.projectId, payload.commitSha, deploymentId);

        // เขียน build secrets ลง temp files (--secret id=KEY,src=FILE)
        // ห้ามส่งผ่าน --build-arg เด็ดขาด (threat-model.md)
        const buildSecrets: BuildSecret[] = [];
        if (envInject.buildSecretValues.length > 0) {
          secretDir = join(tmpdir(), `zixploy-build-secrets-${deploymentId}`);
          mkdirSync(secretDir, { recursive: true });
          for (const { key, value } of envInject.buildSecretValues) {
            const filePath = join(secretDir, key);
            writeFileSync(filePath, value, { mode: 0o600 });
            buildSecrets.push({ id: key, sourcePath: filePath });
          }
        }

        const result = await deps.buildImage({
          contextDir: buildContextDir,
          dockerfilePath: project.dockerfilePath,
          tag,
          target: project.targetStage,
          labels: deploymentLabels(job.projectId, deploymentId),
          // buildArgs เป็น Record<string, string> เสมอ (อาจว่าง) — ไม่ส่ง undefined
          buildArgs: envInject.buildArgs,
          // secrets ใช้ spread เพราะ exactOptionalPropertyTypes ห้าม undefined explicit
          ...(buildSecrets.length > 0 ? { secrets: buildSecrets } : {}),
          timeoutMs: buildMs,
          signal: deployTimeout.signal,
          onLog: safeLog,
        });
        imageTag = tag;
        imageDigest = result.digest;
      } finally {
        // ลบ build secret files ก่อน (ข้อมูล sensitive) แล้วค่อยลบ workspace
        if (secretDir) {
          try {
            rmSync(secretDir, { recursive: true, force: true });
          } catch {
            // Windows อาจปล่อย handle ช้า — ปล่อยให้ OS เก็บกวาด
          }
        }
        // ลบ workspace เสมอไม่ว่าสำเร็จหรือล้มเหลว — ไม่ต้องรอ M7 cleanup job
        removeWorkspace(deploymentId);
      }

      transitionDeployment(db, deploymentId, "starting", { imageTag, imageDigest });
    } else {
      // --- rollback: verify image ยังอยู่จริงก่อน แล้วข้าม cloning/building ---
      const info = await deps.docker.inspectImage(payload.imageTag);
      const digestMatches =
        info?.Id === payload.imageDigest || (info?.RepoDigests ?? []).includes(payload.imageDigest);
      if (!info || !digestMatches) {
        failDeployment(
          db,
          deploymentId,
          "ROLLBACK_IMAGE_UNAVAILABLE",
          `image ${payload.imageTag} ไม่พบในเครื่องหรือ digest ไม่ตรงกับที่บันทึกไว้`,
        );
        return { outcome: "failed", retryable: false };
      }
      imageTag = payload.imageTag;
      imageDigest = payload.imageDigest;
      transitionToStartingForRollback(db, deploymentId);
    }

    // --- starting: create + start container (idempotent — ลบของเก่าชื่อเดียวกันก่อนเสมอ) ---
    // preflight: fail เร็วถ้า daemon ไม่พร้อม แทนรอ subprocess timeout ทีละ call (create/network/start)
    if (!(await deps.docker.ping())) {
      throw new AppError(
        "DOCKER_UNAVAILABLE",
        "Docker daemon ไม่พร้อมใช้งาน — ยกเลิกก่อนเริ่ม starting step",
      );
    }
    await deps.docker.removeContainer(cName, { force: true });
    await deps.docker.ensureNetwork(PROXY_NETWORK);

    // โหลด domain configs ที่ enabled → สร้าง Traefik labels
    // labels merge เข้ากับ deploymentLabels — ไม่รับ raw label จากผู้ใช้ (threat-model.md)
    const domainConfigs = loadProjectDomains(db, job.projectId);
    const containerLabels = {
      ...deploymentLabels(job.projectId, deploymentId),
      ...buildTraefikLabels(domainConfigs, job.projectId),
    };

    // โหลด active volumes — ensure Docker volumes มีอยู่จริงก่อนสร้าง container (Phase 7 M4)
    const activeVolumes = loadActiveVolumes(db, job.projectId);
    for (const vol of activeVolumes) {
      // single-writer warning: ทั้ง candidate และ old container จะ share volume (start-before-stop)
      if (vol.accessMode === "single-writer") {
        safeLog(
          `[volume] ⚠️  volume '${vol.dockerName}' (mount: ${vol.mountPath}) มี access_mode=single-writer ` +
            "— container เก่าและใหม่อาจเขียน volume พร้อมกันชั่วคราวระหว่าง activation (start-before-stop)",
        );
      }
      // docker volume create เป็น idempotent — ไม่ fail ถ้า volume มีอยู่แล้ว
      await deps.docker.createVolume({
        name: vol.dockerName,
        driver: vol.driver,
        labels: { "platform.managed": "true", "platform.volume_id": vol.id },
      });
    }

    // exposed port ทำ start-before-stop ไม่ได้ (host port bind ได้ container เดียว) — หยุดของเก่า
    // ก่อน start candidate ยอมแลก downtime สั้น ๆ เฉพาะ project ที่เปิดฟีเจอร์นี้เอง ผู้ใช้ที่ต้อง
    // zero-downtime แท้ควร route ผ่าน domain (Traefik) แทนการ expose port ตรง
    const publishExposedPort = project.exposedPort != null && project.internalPort != null;
    if (project.exposedPort != null && project.internalPort == null) {
      safeLog("[port] ⚠️  ตั้ง exposed port ไว้แต่ยังไม่ได้ระบุ internal port — ข้ามการ publish port รอบนี้");
    }
    if (publishExposedPort) {
      const oldId = findActiveContainerId(db, job.projectId);
      if (oldId) {
        safeLog(
          `[port] exposed port ${project.exposedPort} — หยุด container เก่าก่อน start ตัวใหม่ ` +
            "(host port ผูกได้ container เดียว จึงมี downtime สั้น ๆ ระหว่างสลับ)",
        );
        await deps.docker.stopContainer(oldId);
        stoppedOldForPort = oldId;
      }
    }

    const { containerId } = await deps.docker.createContainer({
      name: cName,
      image: imageTag,
      labels: containerLabels,
      ...(project.startCommand ? { cmd: [project.startCommand] } : {}),
      cpuLimit: project.cpuLimit,
      memoryLimitMb: project.memoryLimitMb,
      restartPolicy: project.restartPolicy,
      networkName: PROXY_NETWORK,
      // runtimeEnv เป็น Record<string, string> เสมอ (อาจว่าง) — ไม่ส่ง undefined
      env: envInject.runtimeEnv,
      // exposed port (Phase 14) — internalPort ยืนยันแล้วว่าไม่ null ผ่าน publishExposedPort
      ...(publishExposedPort
        ? {
            publishPorts: [
              // biome-ignore lint/style/noNonNullAssertion: publishExposedPort การันตี non-null แล้ว
              { hostPort: project.exposedPort!, containerPort: project.internalPort! },
            ],
          }
        : {}),
      // Named volume mounts — Docker volumes สร้างแล้วในขั้นตอนก่อนหน้า
      ...(activeVolumes.length > 0
        ? {
            volumes: activeVolumes.map((v) => ({
              dockerName: v.dockerName,
              mountPath: v.mountPath,
              ...(v.readOnly ? { readOnly: true } : {}),
            })),
          }
        : {}),
    });
    await deps.docker.startContainer(containerId);
    transitionDeployment(db, deploymentId, "health_checking", { containerId });

    // --- health check ---
    await deps.waitForHealthy({
      docker: deps.docker,
      containerId,
      networkName: PROXY_NETWORK,
      internalPort: project.internalPort,
      healthCheckPath: project.healthCheckPath,
      intervalSec: project.healthCheckIntervalSec,
      timeoutSec: project.healthCheckTimeoutSec,
      retries: project.healthCheckRetries,
      signal: deployTimeout.signal,
    });

    // --- activating (ADR-0004: candidate ผ่านแล้วเท่านั้นถึงปิดของเก่า) ---
    transitionDeployment(db, deploymentId, "activating");
    const oldContainerId = findActiveContainerId(db, job.projectId);
    await deps.activate({ docker: deps.docker, oldContainerId });

    // --- succeeded ---
    transitionDeployment(db, deploymentId, "succeeded");
    setProjectStatus(db, job.projectId, "running");

    // retention cleanup best-effort — deploy ถือว่าสำเร็จแล้วไม่ว่า cleanup จะเป็นอย่างไร
    // (ห้าม throw ทับ error ตรงนี้ไม่ให้กระทบผลลัพธ์ deploy ที่สำเร็จไปแล้วจริง ๆ)
    try {
      await cleanupProjectImages({
        db,
        docker: deps.docker,
        projectId: job.projectId,
        onLog: safeLog,
      });
    } catch (err) {
      deps.onLog(
        `retention cleanup ล้มเหลว (ไม่กระทบผลลัพธ์ deploy นี้): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // build log retention — ลบ log ที่เกิน buildRetentionDays (Phase 6 M5)
    try {
      pruneBuildLogs(db);
    } catch {
      // best-effort — ไม่ fail deploy ถ้า prune ล้มเหลว
    }

    return { outcome: "done" };
  } catch (err) {
    // timer นี้เองเป็นสาเหตุ → error code ต้องบอกสาเหตุจริง (DEPLOY_TIMEOUT_EXCEEDED) ไม่ใช่
    // symptom ปลายทางที่ downstream โยนมาตอนสังเกตเห็น signal abort (เช่น CLONE_FAILED)
    const code = deployTimeout.timedOut()
      ? "DEPLOY_TIMEOUT_EXCEEDED"
      : err instanceof AppError
        ? err.code
        : "BUILD_FAILED";
    const message = err instanceof Error ? err.message : String(err);

    // ลบ candidate container ถ้าสร้างไปแล้วบางส่วน (health check ไม่ผ่าน ฯลฯ) — ของเก่าไม่ถูกแตะเลย (ADR-0004)
    await deps.docker.removeContainer(cName, { force: true }).catch(() => {});

    // exposed port path หยุดของเก่าไปก่อน start candidate — restart คืนให้บริการต่อ (best-effort)
    if (stoppedOldForPort) {
      await deps.docker.startContainer(stoppedOldForPort).catch(() => {
        deps.onLog(
          `[port] restart container เก่า (${stoppedOldForPort}) คืนไม่สำเร็จ — service อาจหยุดจนกว่าจะ deploy/restart ใหม่`,
        );
      });
    }

    // เช็คว่ายัง non-terminal ก่อน mark failed — กัน race กับ recoverStaleLeases ที่อาจ mark ไปแล้ว
    // (ถ้า mark ซ้ำ assertTransition จะ throw เพราะ 'failed' เป็น terminal state)
    const status = getDeploymentStatus(db, deploymentId);
    if (status && !isTerminal(status)) {
      failDeployment(db, deploymentId, code, message);
    }

    // build/rollback error ไม่ auto-retry (ADR-0003) — ผู้ใช้ต้องกด redeploy เองถ้าต้องการลองใหม่
    return { outcome: "failed", retryable: false };
  } finally {
    deployTimeout.cleanup();
  }
}
