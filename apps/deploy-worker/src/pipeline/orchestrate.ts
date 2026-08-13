/**
 * Multi-container (compose-style) deploy pipeline — Phase 18 · Phase C
 *
 * analog ของ runBuildOrRollbackPipeline (build.ts) แต่ fan-out หลาย container ต่อ deployment
 * เดินตาม state machine เดิม (strict 1:1) โดยผ่านทุก state ครั้งเดียว:
 *   cloning → building → starting → health_checking → activating → succeeded
 *
 * แต่ละ state ทำงานของหลาย component พร้อมกันภายใน:
 *   cloning   — clone repo ครั้งเดียว (ถ้ามี build component)
 *   building  — build ทุก build-component + pull ทุก image-component
 *   starting  — สร้าง per-deployment network + สร้าง container ทุกตัว (มี DNS alias)
 *   health_checking — start ตามลำดับ topological + gate ตัวที่ต้อง healthy ก่อนไปตัวถัดไป
 *   activating — ของใหม่ healthy ครบแล้ว → หยุด generation เก่าทั้งชุด + ลบ network เก่า
 *
 * ADR-0004 start-before-stop สำหรับหลาย container: ของใหม่ทั้งชุด healthy ครบก่อน ถึงแตะของเก่า
 * partial failure = ลบ container ใหม่ "ทั้งหมด" + network ใหม่ และ **ห้ามแตะ generation เก่าเลย**
 *
 * MVP (Phase C): env เป็น project-scope (component-scoped = Phase F); ไม่ mount named volume
 * (Phase F); managed_ref = verify ว่ามี service รันอยู่ (การ inject connection env = Phase F);
 * image cleanup ข้ามไปก่อน (Phase D/F) — กันลบ image ผิดตัว ปลอดภัยกว่าลบมั่ว
 *
 * ทุก dependency ฉีดเข้ามาเป็นพารามิเตอร์ (เหมือน build.ts) เพื่อ unit-test ได้โดยไม่ต้องมี Docker จริง
 */

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  AppError,
  BUILD_SANDBOX_LIMITS,
  buildTraefikLabels,
  componentContainerName,
  componentImageName,
  componentLabels,
  deploymentNetworkLabels,
  deploymentNetworkName,
  isTerminal,
  PROXY_NETWORK,
  serviceContainerName,
} from "@zixploy/shared";
import { failDeployment, getDeploymentStatus, transitionDeployment } from "../db/deployment-state";
import { loadProjectConfig, setProjectStatus } from "../db/project-config";
import type { BuildImageParams, BuildImageResult } from "../docker/buildkit";
import type { DockerCliClient } from "../docker/cli-client";
import { loadProjectDomains } from "../domains/loader";
import { injectEnvVars } from "../env/inject";
import { buildRedactFn } from "../env/redaction";
import type { CloneParams } from "../git/clone";
import type { MasterKeys } from "../github/master-key";
import type { MintedToken } from "../github/token";
import type { ClaimedJob } from "../queue";
import {
  assertDockerfileWithinContext,
  assertWorkspaceSizeWithinLimit,
  createWorkspace,
  removeWorkspace,
} from "../workspace";
import {
  type DeployComponent,
  loadDeployComponents,
  loadPreviousGenerationContainers,
  previousDeploymentId,
  recordDeploymentContainer,
} from "./components-loader";
import type { ContainerHealthParams, HealthCheckParams } from "./health-check";
import type { DeployJobPayload } from "./payload";
import { createDeployTimeout } from "./timeout";
import { topoOrder } from "./topo";

export interface OrchestrateDeps {
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
  /** รอ Docker-native health ของ dependency ที่ระบุ condition='healthy' (Phase 18 · F) */
  waitForContainerHealthy: (params: ContainerHealthParams) => Promise<"healthy" | "no-healthcheck">;
  /** สร้าง env เชื่อม managed database ให้ dependent ของ managed_ref (Phase 18 · F) */
  buildManagedRefEnv: (
    db: Database,
    masterKeys: MasterKeys | null,
    ref: DeployComponent,
  ) => Promise<Record<string, string>>;
  onLog: (line: string) => void;
  /** override drain ก่อนหยุดของเก่า — เทสต์ตั้ง 0 */
  drainMs?: number;
}

/** grace period ก่อน Docker เริ่มนับ healthcheck ว่า fail (ให้ process ใน container บูตก่อน) */
const HEALTHCHECK_START_PERIOD_SEC = 5;

type BuildPayload = Extract<DeployJobPayload, { kind: "build" }>;

interface CreatedContainer {
  component: DeployComponent;
  containerId: string;
  imageTag: string;
}

/**
 * HTTP health-gate port ของ component — เฉพาะ web (ที่ join PROXY_NETWORK) เท่านั้นที่ worker
 * เข้าถึงได้ผ่าน HTTP probe · non-web อยู่บน per-deployment network ล้วน worker ไม่ได้ต่ออยู่จึง
 * probe ไม่ถึง (การ health-gate non-web ต้องใช้ Docker-native healthcheck = Phase F) — คืน null
 * ให้ข้าม HTTP gate แล้ว start ต่อได้เลย (topological order ยังการันตีลำดับ dependency อยู่)
 */
function healthPort(c: DeployComponent): number | null {
  return c.isWeb ? c.webPort : null;
}

export async function runComposePipeline(
  deps: OrchestrateDeps,
  job: ClaimedJob,
  payload: BuildPayload,
  signal: AbortSignal,
): Promise<{ outcome: "done" } | { outcome: "failed"; retryable: false }> {
  const { db, docker, onLog } = deps;
  const deploymentId = job.deploymentId;
  if (!deploymentId) return { outcome: "failed", retryable: false };

  const project = loadProjectConfig(db, job.projectId);
  if (!project) {
    failDeployment(db, deploymentId, "WORKSPACE_ERROR", "ไม่พบ project configuration ใน DB");
    return { outcome: "failed", retryable: false };
  }

  // โหลด component ทั้งชุดครั้งเดียว — topo ต้องเห็น managed_ref ด้วย (เป็น dependency root ที่รันแล้ว)
  const allComponents = loadDeployComponents(db, job.projectId);
  const components = allComponents.filter((c) => c.sourceKind !== "managed_ref");
  const refComponents = allComponents.filter((c) => c.sourceKind === "managed_ref");
  if (components.length === 0) {
    failDeployment(
      db,
      deploymentId,
      "WORKSPACE_ERROR",
      "โปรเจกต์ compose ไม่มี component ที่รันเป็น container",
    );
    return { outcome: "failed", retryable: false };
  }

  const buildComps = components.filter((c) => c.sourceKind === "build");
  if (buildComps.length > 0 && payload.source.type !== "github") {
    failDeployment(
      db,
      deploymentId,
      "WORKSPACE_ERROR",
      "โปรเจกต์ compose ที่มี build component ต้องใช้ source แบบ GitHub",
    );
    return { outcome: "failed", retryable: false };
  }

  const networkName = deploymentNetworkName(job.projectId, deploymentId);
  const deployTimeout = createDeployTimeout(signal, project.deployTimeoutSec * 1000);
  const created: CreatedContainer[] = [];

  try {
    const envInject = await injectEnvVars(db, deps.masterKeys, job.projectId, onLog);
    const redactFn = buildRedactFn(envInject.secretValues);
    const safeLog = (line: string) => onLog(redactFn(line));

    // ── verify managed_ref: service ต้องมีและรันอยู่ (MVP: verify เท่านั้น, wiring = Phase F) ──
    for (const ref of refComponents) {
      if (!ref.managedServiceId) continue;
      const info = await docker.inspectContainer(serviceContainerName(ref.managedServiceId));
      if (!info?.State.Running) {
        throw new AppError(
          "SERVICE_PROVISION_FAILED",
          `managed database ที่ component "${ref.name}" อ้างถึงยังไม่รันอยู่`,
        );
      }
    }

    const imageTags = new Map<string, string>();

    // ── cloning: clone repo ครั้งเดียว (ผ่าน state นี้เสมอ แม้ image-only ที่ไม่มีอะไร clone) ──
    transitionDeployment(db, deploymentId, "cloning");
    let workspaceDir: string | null = null;
    try {
      if (buildComps.length > 0 && payload.source.type === "github") {
        const ws = createWorkspace(deploymentId, ".");
        workspaceDir = ws.workspaceDir;
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
          timeoutMs: Math.floor(project.deployTimeoutSec * 1000 * 0.3),
          signal: deployTimeout.signal,
          onLog: safeLog,
        });
        assertWorkspaceSizeWithinLimit(workspaceDir, BUILD_SANDBOX_LIMITS.workspaceMaxMb);
      }

      // ── building: build ทุก build-component + pull ทุก image-component (state นี้ครั้งเดียว) ──
      transitionDeployment(db, deploymentId, "building");
      if (workspaceDir) {
        const perBuildMs = Math.floor((project.deployTimeoutSec * 1000 * 0.7) / buildComps.length);
        for (const c of buildComps) {
          const contextDir = join(workspaceDir, c.buildContext ?? ".");
          const dockerfilePath = c.dockerfilePath ?? "Dockerfile";
          assertDockerfileWithinContext(contextDir, dockerfilePath);
          const tag = componentImageName(job.projectId, c.id, payload.commitSha, deploymentId);
          safeLog(`[build] component "${c.name}" → ${tag}`);
          await deps.buildImage({
            contextDir,
            dockerfilePath,
            tag,
            target: c.targetStage,
            labels: componentLabels(job.projectId, deploymentId, c.id),
            buildArgs: envInject.buildArgs,
            timeoutMs: perBuildMs,
            signal: deployTimeout.signal,
            onLog: safeLog,
          });
          imageTags.set(c.id, tag);
        }
      }
      for (const c of components.filter((x) => x.sourceKind === "image")) {
        if (!c.imageRef) {
          throw new AppError("SERVICE_PROVISION_FAILED", `component "${c.name}" ไม่มี imageRef`);
        }
        safeLog(`[pull] component "${c.name}" → ${c.imageRef}`);
        await docker.pullImage(c.imageRef);
        imageTags.set(c.id, c.imageRef);
      }
    } finally {
      if (workspaceDir) removeWorkspace(deploymentId);
    }

    // ── starting: preflight + สร้าง per-deployment network + สร้าง container ทุกตัว ──
    transitionDeployment(db, deploymentId, "starting");
    if (!(await docker.ping())) {
      throw new AppError("DOCKER_UNAVAILABLE", "Docker daemon ไม่พร้อมใช้งาน");
    }
    await docker.ensureNetwork(networkName, deploymentNetworkLabels(job.projectId, deploymentId));
    await docker.ensureNetwork(PROXY_NETWORK);

    const domainConfigs = loadProjectDomains(db, job.projectId);
    const compById = new Map(allComponents.map((c) => [c.id, c]));

    for (const c of components) {
      const image = imageTags.get(c.id);
      if (!image) throw new AppError("BUILD_FAILED", `component "${c.name}" ไม่มี image`);
      const cName = componentContainerName(job.projectId, deploymentId, c.id);
      await docker.removeContainer(cName, { force: true });

      // web component ได้ Traefik labels ของ project (MVP: web เดียว; multi-web = Phase D)
      const labels = {
        ...componentLabels(job.projectId, deploymentId, c.id),
        ...(c.isWeb ? buildTraefikLabels(domainConfigs, job.projectId) : {}),
      };

      // managed_ref dependency → ฉีด connection env (URL/host/port/user/pass/db) + ต้อง join
      // PROXY_NETWORK เพื่อ resolve ชื่อ container ของ service (service อยู่บน proxy net ไม่ใช่ per-deployment)
      const refDeps = c.dependsOn
        .map((d) => compById.get(d.id))
        .filter((dc): dc is DeployComponent => dc?.sourceKind === "managed_ref");
      let componentEnv = envInject.runtimeEnv;
      for (const ref of refDeps) {
        const refEnv = await deps.buildManagedRefEnv(db, deps.masterKeys, ref);
        componentEnv = { ...componentEnv, ...refEnv };
      }
      const needsProxy = c.isWeb || refDeps.length > 0;

      const { containerId } = await docker.createContainer({
        name: cName,
        image,
        labels,
        networkName,
        networkAliases: [c.name],
        ...(c.command ? { cmd: [c.command] } : {}),
        cpuLimit: c.cpuLimit,
        memoryLimitMb: c.memoryLimitMb,
        restartPolicy: c.restartPolicy,
        env: componentEnv,
        // Docker-native HEALTHCHECK (Phase 18 · F) — จำเป็นให้ component อื่นรอแบบ condition='healthy'
        ...(c.healthCmd
          ? {
              healthCheck: {
                cmd: ["CMD-SHELL", c.healthCmd],
                intervalSec: c.healthCheckIntervalSec,
                timeoutSec: c.healthCheckTimeoutSec,
                retries: c.healthCheckRetries,
                startPeriodSec: HEALTHCHECK_START_PERIOD_SEC,
              },
            }
          : {}),
      });
      // join proxy: web (สำหรับ Traefik) หรือ component ที่ต้องต่อ managed database
      if (needsProxy) await docker.connectNetwork(PROXY_NETWORK, containerId);
      created.push({ component: c, containerId, imageTag: image });
    }

    // ── health_checking: start ตามลำดับ topological + gate ตัวที่มี port ให้ตรวจ ──
    const webContainerId =
      created.find((c) => c.component.isWeb)?.containerId ?? created[0]?.containerId;
    transitionDeployment(db, deploymentId, "health_checking", {
      ...(webContainerId ? { containerId: webContainerId } : {}),
    });
    const byId = new Map(created.map((c) => [c.component.id, c]));
    // topo ต้องเห็น component ทั้งชุด (รวม managed_ref) เพื่อไม่ throw ตอน dependsOn ชี้ไป db
    for (const comp of topoOrder(allComponents)) {
      const entry = byId.get(comp.id);
      if (!entry) continue; // managed_ref / ตัวที่ไม่ได้สร้าง = ข้าม (ถือว่าพร้อมแล้ว)

      // gate: รอ dependency ที่ระบุ condition='healthy' ให้ healthy ก่อน start ตัวนี้ (Phase 18 · F)
      // topological order การันตีว่า dependency ถูก start ไปแล้ว (มาก่อนใน loop) — รอ Docker health ได้เลย
      for (const dep of comp.dependsOn) {
        if (dep.condition !== "healthy") continue;
        const depComp = compById.get(dep.id);
        if (!depComp) continue;
        // managed_ref → รอ health ของ service container; อื่น ๆ → รอ container ที่เพิ่งสร้าง
        const target =
          depComp.sourceKind === "managed_ref"
            ? depComp.managedServiceId
              ? serviceContainerName(depComp.managedServiceId)
              : null
            : (byId.get(depComp.id)?.containerId ?? null);
        if (!target) continue;
        safeLog(`[health] "${comp.name}" รอ dependency "${depComp.name}" ให้ healthy ก่อน start`);
        const outcome = await deps.waitForContainerHealthy({
          docker,
          containerId: target,
          intervalSec: depComp.healthCheckIntervalSec,
          timeoutSec: depComp.healthCheckTimeoutSec,
          retries: depComp.healthCheckRetries,
          signal: deployTimeout.signal,
        });
        if (outcome === "no-healthcheck") {
          safeLog(
            `[health] ⚠️ dependency "${depComp.name}" ไม่มี healthcheck — ถือว่า started แทน healthy ` +
              "(ตั้ง healthCmd ที่ component นั้นเพื่อ gate จริง)",
          );
        }
      }

      await docker.startContainer(entry.containerId);
      const port = healthPort(comp);
      if (port != null) {
        safeLog(`[health] รอ component "${comp.name}" พร้อม (port ${port})`);
        await deps.waitForHealthy({
          docker,
          containerId: entry.containerId,
          // web probe ผ่าน PROXY_NETWORK — worker ต่ออยู่บน net นี้ (ไม่ใช่ per-deployment net)
          // จึง fetch IP ของ web container ได้ (เหมือน single-container pipeline)
          networkName: PROXY_NETWORK,
          internalPort: port,
          healthCheckPath: comp.healthCheckPath,
          intervalSec: comp.healthCheckIntervalSec,
          timeoutSec: comp.healthCheckTimeoutSec,
          retries: comp.healthCheckRetries,
          signal: deployTimeout.signal,
        });
      }
      recordDeploymentContainer(db, deploymentId, comp.id, {
        containerId: entry.containerId,
        imageTag: entry.imageTag,
        status: "running",
      });
    }

    // ── activating: ของใหม่ healthy ครบแล้ว → หยุด generation เก่า + ลบ network เก่า ──
    transitionDeployment(db, deploymentId, "activating");
    const oldContainers = loadPreviousGenerationContainers(db, job.projectId);
    const oldDeploymentId = previousDeploymentId(db, job.projectId);
    if (oldContainers.length > 0) {
      await sleep(deps.drainMs ?? 5_000);
      for (const old of oldContainers) {
        await docker.stopContainer(old.containerId).catch(() => {});
        await docker.removeContainer(old.containerId, { force: true }).catch(() => {});
      }
    }
    if (oldDeploymentId && oldDeploymentId !== deploymentId) {
      await docker
        .removeNetwork(deploymentNetworkName(job.projectId, oldDeploymentId))
        .catch(() => {});
    }

    // ── succeeded: ตั้ง deployments.container_id = web component (legacy readers อ่าน field นี้) ──
    if (webContainerId) {
      db.query("UPDATE deployments SET container_id = ? WHERE id = ?").run(
        webContainerId,
        deploymentId,
      );
    }
    transitionDeployment(db, deploymentId, "succeeded");
    setProjectStatus(db, job.projectId, "running");
    return { outcome: "done" };
  } catch (err) {
    const code = deployTimeout.timedOut()
      ? "DEPLOY_TIMEOUT_EXCEEDED"
      : err instanceof AppError
        ? err.code
        : "BUILD_FAILED";
    const message = err instanceof Error ? err.message : String(err);

    // teardown: ลบ container ใหม่ "ทั้งหมด" + network ใหม่ — generation เก่าไม่ถูกแตะ (ADR-0004)
    for (const c of created) {
      await docker.removeContainer(c.containerId, { force: true }).catch(() => {});
    }
    // เผื่อ throw ระหว่าง create ก่อน push เข้า created — ลบตามชื่อ deterministic อีกชั้น
    // (managed_ref ไม่อยู่ใน components จึงไม่ถูกแตะ — service คนละ lifecycle)
    for (const c of components) {
      await docker
        .removeContainer(componentContainerName(job.projectId, deploymentId, c.id), { force: true })
        .catch(() => {});
    }
    await docker.removeNetwork(networkName).catch(() => {});

    const status = getDeploymentStatus(db, deploymentId);
    if (status && !isTerminal(status)) {
      failDeployment(db, deploymentId, code, message);
    }
    return { outcome: "failed", retryable: false };
  } finally {
    deployTimeout.cleanup();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
