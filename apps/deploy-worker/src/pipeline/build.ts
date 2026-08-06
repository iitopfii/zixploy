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
import {
  AppError,
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
import type { BuildImageParams, BuildImageResult } from "../docker/buildkit";
import type { DockerCliClient } from "../docker/cli-client";
import type { CloneParams } from "../git/clone";
import type { MasterKeys } from "../github/master-key";
import type { MintedToken } from "../github/token";
import type { ClaimedJob } from "../queue";
import { assertDockerfileWithinContext, createWorkspace, removeWorkspace } from "../workspace";
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

  try {
    let imageTag: string;
    let imageDigest: string;

    if (payload.kind === "build") {
      const { cloneMs, buildMs } = splitTimeoutBudget(project.deployTimeoutSec);

      // --- cloning ---
      transitionDeployment(db, deploymentId, "cloning");
      const { workspaceDir, buildContextDir } = createWorkspace(deploymentId, project.buildContext);
      try {
        const token = await deps.mintInstallationToken(db, deps.masterKeys, payload.installationId);
        await deps.cloneCommit({
          repoFullName: payload.repoFullName,
          commitSha: payload.commitSha,
          token: token.token,
          destDir: workspaceDir,
          timeoutMs: cloneMs,
          signal: deployTimeout.signal,
          onLog: deps.onLog,
        });
        // ตรวจหลัง clone จริงเท่านั้น (ต้องมี buildContextDir อยู่จริงก่อนถึงจะ realpath ได้)
        assertDockerfileWithinContext(buildContextDir, project.dockerfilePath);

        // --- building ---
        transitionDeployment(db, deploymentId, "building");
        const tag = imageName(job.projectId, payload.commitSha, deploymentId);
        const result = await deps.buildImage({
          contextDir: buildContextDir,
          dockerfilePath: project.dockerfilePath,
          tag,
          target: project.targetStage,
          labels: deploymentLabels(job.projectId, deploymentId),
          timeoutMs: buildMs,
          signal: deployTimeout.signal,
          onLog: deps.onLog,
        });
        imageTag = tag;
        imageDigest = result.digest;
      } finally {
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
    const { containerId } = await deps.docker.createContainer({
      name: cName,
      image: imageTag,
      labels: deploymentLabels(job.projectId, deploymentId),
      ...(project.startCommand ? { cmd: [project.startCommand] } : {}),
      cpuLimit: project.cpuLimit,
      memoryLimitMb: project.memoryLimitMb,
      restartPolicy: project.restartPolicy,
      networkName: PROXY_NETWORK,
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
        onLog: deps.onLog,
      });
    } catch (err) {
      deps.onLog(
        `retention cleanup ล้มเหลว (ไม่กระทบผลลัพธ์ deploy นี้): ${err instanceof Error ? err.message : String(err)}`,
      );
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
