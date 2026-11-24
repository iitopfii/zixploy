/**
 * Multi-container (compose-style) deploy pipeline — Phase 18 · Phase C
 *
 * analog ของ runBuildOrRollbackPipeline (build.ts) แต่ fan-out หลาย container ต่อ deployment
 * เดินตาม state machine เดิม (strict 1:1) โดยผ่านทุก state ครั้งเดียว:
 *   cloning → building → starting → health_checking → activating → succeeded
 *
 * แต่ละ state ทำงานของหลาย component พร้อมกันภายใน:
 *   cloning   — clone repo ของ project ครั้งเดียว + repo ของ component ที่ตั้ง repo แยก (0.1.25)
 *   building  — build ทุก build-component + pull ทุก image-component
 *   starting  — สร้าง per-deployment network + สร้าง container ทุกตัว (มี DNS alias)
 *   health_checking — start ตามลำดับ topological + gate ตัวที่ต้อง healthy ก่อนไปตัวถัดไป
 *   activating — ของใหม่ healthy ครบแล้ว → หยุด generation เก่าทั้งชุด + ลบ network เก่า
 *
 * ADR-0004 start-before-stop สำหรับหลาย container: ของใหม่ทั้งชุด healthy ครบก่อน ถึงแตะของเก่า
 * partial failure = ลบ container ใหม่ "ทั้งหมด" + network ใหม่ และ **ห้ามแตะ generation เก่าเลย**
 *
 * web หลายตัวได้ (0.1.24): domain ผูกกับ component + route ตาม path — ดู domainsFor ด้านล่าง
 * named volume ต่อ component (0.1.24): volumes.component_id — ดู loadComponentVolumes
 * build arg/secret ต่อ component (0.1.25): env scope build/both ของ project + ของ component (component ชนะ)
 * image cleanup ข้ามไปก่อน (Phase D/F) — กันลบ image ผิดตัว ปลอดภัยกว่าลบมั่ว
 *
 * ทุก dependency ฉีดเข้ามาเป็นพารามิเตอร์ (เหมือน build.ts) เพื่อ unit-test ได้โดยไม่ต้องมี Docker จริง
 */

import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppError,
  BUILD_SANDBOX_LIMITS,
  buildTraefikLabels,
  componentContainerName,
  componentImageName,
  componentLabels,
  componentServiceName,
  deploymentNetworkLabels,
  deploymentNetworkName,
  isTerminal,
  linkNetworkDockerName,
  PROXY_NETWORK,
  projectServiceName,
  serviceContainerName,
  splitCommandArgs,
} from "@zixploy/shared";
import { failDeployment, getDeploymentStatus, transitionDeployment } from "../db/deployment-state";
import { loadProjectConfig, setProjectStatus } from "../db/project-config";
import type { BuildImageParams, BuildImageResult, BuildSecret } from "../docker/buildkit";
import type { DockerCliClient } from "../docker/cli-client";
import { loadProjectDomains } from "../domains/loader";
import { type EnvInjection, injectComponentEnv, injectEnvVars } from "../env/inject";
import { buildRedactFn } from "../env/redaction";
import type { CloneParams, ResolveBranchParams } from "../git/clone";
import type { MasterKeys } from "../github/master-key";
import type { MintedToken } from "../github/token";
import type { ClaimedJob } from "../queue";
import { loadRegistryAuth, markRegistryUsed } from "../registries/auth";
import { countUnassignedActiveVolumes, loadComponentVolumes } from "../volumes/loader";
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
  /** branch → commit ล่าสุด ของ component ที่มี repo ของตัวเอง (0.1.25) */
  resolveBranchHead: (params: ResolveBranchParams) => Promise<string>;
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
/**
 * ชื่อ component ของ project นี้ที่ชนกับ project อื่นใน link network เดียวกัน (0.1.26)
 * บน network ร่วม ชื่อ component คือ DNS alias — ชนกันแล้ว Docker จะ round-robin ไปทั้งสอง project
 */
export function findLinkNameClashes(
  db: Database,
  projectId: string,
  linkNetwork: string,
  names: string[],
): { name: string; projectName: string }[] {
  if (names.length === 0) return [];
  const placeholders = names.map(() => "?").join(", ");
  return db
    .query<{ name: string; project_name: string }, string[]>(
      `SELECT c.name, p.name AS project_name
         FROM project_components c JOIN projects p ON p.id = c.project_id
        WHERE p.link_network = ? AND p.id != ? AND p.archived_at IS NULL
          AND c.source_kind != 'managed_ref' AND c.name IN (${placeholders})
        ORDER BY c.name`,
    )
    .all(linkNetwork, projectId, ...names)
    .map((r) => ({ name: r.name, projectName: r.project_name }));
}

function healthPort(c: DeployComponent): number | null {
  return c.isWeb ? c.webPort : null;
}

/** github_installations.id (ULID ภายใน) → installation ID ตัวเลขของ GitHub — ต้อง active */
function installationNumber(db: Database, rowId: string, componentName: string): number {
  const row = db
    .query<{ installation_id: number; status: string }, [string]>(
      "SELECT installation_id, status FROM github_installations WHERE id = ?",
    )
    .get(rowId);
  if (row?.status !== "active") {
    throw new AppError(
      "CLONE_FAILED",
      `GitHub installation ของ repo ที่ component "${componentName}" ใช้ไม่พร้อม (ไม่พบหรือไม่ active)`,
    );
  }
  return row.installation_id;
}

/** build arg + secret ของ component: project-wide ก่อน แล้ว component-scoped ทับ key เดียวกัน */
export function mergeBuildEnv(
  base: EnvInjection,
  scoped: EnvInjection | undefined,
): { buildArgs: Record<string, string>; secrets: Array<{ key: string; value: string }> } {
  const secretMap = new Map<string, string>();
  for (const s of base.buildSecretValues) secretMap.set(s.key, s.value);
  const buildArgs = { ...base.buildArgs };
  for (const s of scoped?.buildSecretValues ?? []) {
    secretMap.set(s.key, s.value);
    delete buildArgs[s.key];
  }
  for (const [k, v] of Object.entries(scoped?.buildArgs ?? {})) {
    buildArgs[k] = v;
    secretMap.delete(k);
  }
  return {
    buildArgs,
    secrets: [...secretMap].map(([key, value]) => ({ key, value })),
  };
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
  const projectSourced = buildComps.filter((c) => !c.gitSource);
  if (projectSourced.length > 0 && payload.source.type !== "github") {
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
    // env เฉพาะ component โหลดครั้งเดียวก่อน clone — ใช้ทั้ง build arg/secret, runtime env และ redact log
    // ของ build (secret ของ component ต้องไม่หลุดใน build log เหมือนของ project)
    const scopedEnv = new Map<string, EnvInjection>();
    for (const c of components) {
      scopedEnv.set(
        c.id,
        await injectComponentEnv(db, deps.masterKeys, job.projectId, c.id, onLog),
      );
    }
    const redactFn = buildRedactFn([
      ...envInject.secretValues,
      ...[...scopedEnv.values()].flatMap((s) => s.secretValues),
    ]);
    const safeLog = (line: string) => onLog(redactFn(line));

    // Fail-loud เหมือน single-container pipeline (build.ts): env ตั้งไว้แต่ฉีดไม่ได้เลย = ตัดจบ
    if (envInject.definedCount > 0 && envInject.failedKeys.length === envInject.definedCount) {
      throw new AppError(
        "ENV_INJECTION_FAILED",
        `environment variables ทั้ง ${envInject.definedCount} ตัวฉีดเข้า deployment ไม่ได้เลย ` +
          `(${envInject.failedKeys.join(", ")}) — มักเกิดจาก master key เปลี่ยนหรือหาย ` +
          "แก้โดยกรอกค่าใหม่ในแท็บ Environment แล้ว deploy อีกครั้ง",
      );
    }
    if (envInject.failedKeys.length > 0) {
      safeLog(
        `[env] ⚠️ ${envInject.failedKeys.length} จาก ${envInject.definedCount} ตัว decrypt ไม่ได้ ` +
          `(${envInject.failedKeys.join(", ")}) — ค่าเหล่านี้จะไม่ถูกส่งเข้า container`,
      );
    }

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

    // ── cloning: repo ของ project ครั้งเดียว + repo ของ component ที่ตั้งแยก (repo@commit ซ้ำ clone ครั้งเดียว)
    // ผ่าน state นี้เสมอ แม้ image-only ที่ไม่มีอะไร clone · แต่ละ repo อยู่ใน sub-dir ของ workspace
    // ไม่ซ้อนกัน — build context ของ repo หนึ่งจึงไม่มีไฟล์ของอีก repo ปน
    transitionDeployment(db, deploymentId, "cloning");
    let workspaceDir: string | null = null;
    let secretDir: string | null = null;
    /** component id → root ของ checkout ที่ build */
    const checkoutOf = new Map<string, string>();
    /** commit ที่ build ของ component ที่มี repo ของตัวเอง */
    const componentCommits: Record<string, string> = {};
    try {
      if (buildComps.length > 0) {
        const ws = createWorkspace(deploymentId, ".");
        workspaceDir = ws.workspaceDir;
        const cloneMs = Math.floor(project.deployTimeoutSec * 1000 * 0.3);

        if (projectSourced.length > 0 && payload.source.type === "github") {
          const dir = join(workspaceDir, "project");
          const token = await deps.mintInstallationToken(
            db,
            deps.masterKeys,
            payload.source.installationId,
          );
          await deps.cloneCommit({
            repoFullName: payload.source.repoFullName,
            commitSha: payload.commitSha,
            token: token.token,
            destDir: dir,
            timeoutMs: cloneMs,
            signal: deployTimeout.signal,
            onLog: safeLog,
          });
          for (const c of projectSourced) checkoutOf.set(c.id, dir);
        }

        const checkouts = new Map<string, string>();
        for (const c of buildComps) {
          if (!c.gitSource) continue;
          const src = c.gitSource;
          const token = await deps.mintInstallationToken(
            db,
            deps.masterKeys,
            installationNumber(db, src.installationRowId, c.name),
          );
          const pinned = payload.componentCommits?.[c.id];
          const sha =
            pinned && /^[0-9a-f]{40}$/.test(pinned)
              ? pinned
              : await deps.resolveBranchHead({
                  repoFullName: src.repoFullName,
                  branch: src.branch,
                  token: token.token,
                  timeoutMs: cloneMs,
                  signal: deployTimeout.signal,
                });
          componentCommits[c.id] = sha;
          safeLog(
            `[source] component "${c.name}" → ${src.repoFullName}@${src.branch} ${sha.slice(0, 7)}` +
              (pinned === sha ? " (commit เดิมของ deployment ก่อน)" : ""),
          );
          const key = `${src.repoFullName.toLowerCase()}@${sha}`;
          let dir = checkouts.get(key);
          if (!dir) {
            dir = join(workspaceDir, `repo-${checkouts.size + 1}`);
            await deps.cloneCommit({
              repoFullName: src.repoFullName,
              commitSha: sha,
              token: token.token,
              destDir: dir,
              timeoutMs: cloneMs,
              signal: deployTimeout.signal,
              onLog: safeLog,
            });
            checkouts.set(key, dir);
          }
          checkoutOf.set(c.id, dir);
        }
        if (Object.keys(componentCommits).length > 0) {
          db.query("UPDATE deployments SET component_commits = ?, updated_at = ? WHERE id = ?").run(
            JSON.stringify(componentCommits),
            Date.now(),
            deploymentId,
          );
        }
        assertWorkspaceSizeWithinLimit(workspaceDir, BUILD_SANDBOX_LIMITS.workspaceMaxMb);
      }

      // ── building: build ทุก build-component + pull ทุก image-component (state นี้ครั้งเดียว) ──
      transitionDeployment(db, deploymentId, "building");
      if (workspaceDir) {
        const perBuildMs = Math.floor((project.deployTimeoutSec * 1000 * 0.7) / buildComps.length);
        for (const c of buildComps) {
          const root = checkoutOf.get(c.id);
          if (!root) {
            throw new AppError("WORKSPACE_ERROR", `component "${c.name}" ไม่มี source ให้ build`);
          }
          const contextDir = join(root, c.buildContext ?? ".");
          const dockerfilePath = c.dockerfilePath ?? "Dockerfile";
          assertDockerfileWithinContext(contextDir, dockerfilePath);
          const sha = componentCommits[c.id] ?? payload.commitSha;
          const tag = componentImageName(job.projectId, c.id, sha, deploymentId);
          safeLog(`[build] component "${c.name}" → ${tag}`);

          // secret → --secret เป็นไฟล์ 0600 เท่านั้น ห้ามใช้ --build-arg (threat-model.md, เหมือน build.ts)
          const { buildArgs, secrets } = mergeBuildEnv(envInject, scopedEnv.get(c.id));
          const buildSecrets: BuildSecret[] = [];
          if (secrets.length > 0) {
            secretDir ??= join(tmpdir(), `zixploy-build-secrets-${deploymentId}`);
            const dir = join(secretDir, c.id);
            mkdirSync(dir, { recursive: true });
            for (const { key, value } of secrets) {
              const filePath = join(dir, key);
              writeFileSync(filePath, value, { mode: 0o600 });
              buildSecrets.push({ id: key, sourcePath: filePath });
            }
          }
          await deps.buildImage({
            contextDir,
            dockerfilePath,
            tag,
            target: c.targetStage,
            labels: componentLabels(job.projectId, deploymentId, c.id),
            buildArgs,
            ...(buildSecrets.length > 0 ? { secrets: buildSecrets } : {}),
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
        const auth = await loadRegistryAuth(db, deps.masterKeys, c.imageRef);
        safeLog(
          `[pull] component "${c.name}" → ${c.imageRef}` +
            (auth ? ` (login ${auth.registry} ด้วย ${auth.username})` : ""),
        );
        await docker.pullImage(c.imageRef, undefined, auth ?? undefined);
        if (auth) markRegistryUsed(db, auth.id);
        imageTags.set(c.id, c.imageRef);
      }
    } finally {
      // ลบไฟล์ secret ก่อน (ข้อมูล sensitive) แล้วค่อยลบ workspace
      if (secretDir) {
        try {
          rmSync(secretDir, { recursive: true, force: true });
        } catch {
          // Windows อาจปล่อย handle ช้า — ปล่อยให้ OS เก็บกวาด
        }
      }
      if (workspaceDir) removeWorkspace(deploymentId);
    }

    // ── starting: preflight + สร้าง per-deployment network + สร้าง container ทุกตัว ──
    transitionDeployment(db, deploymentId, "starting");
    if (!(await docker.ping())) {
      throw new AppError("DOCKER_UNAVAILABLE", "Docker daemon ไม่พร้อมใช้งาน");
    }
    await docker.ensureNetwork(networkName, deploymentNetworkLabels(job.projectId, deploymentId));
    await docker.ensureNetwork(PROXY_NETWORK);

    // link network (0.1.26) — network ร่วมกับ project อื่นที่ตั้งชื่อ link เดียวกัน · ไม่ลบตอน teardown
    // (project อื่นยังใช้อยู่) · container ใหม่ถูกลบเมื่อ deploy ล้ม = หลุดจาก network เอง
    let linkNet: string | null = null;
    if (project.linkNetwork) {
      const clashes = findLinkNameClashes(
        db,
        job.projectId,
        project.linkNetwork,
        components.map((c) => c.name),
      );
      if (clashes.length > 0) {
        throw new AppError(
          "WORKSPACE_ERROR",
          `ชื่อ component ซ้ำกับ project อื่นใน link "${project.linkNetwork}": ` +
            `${clashes.map((c) => `"${c.name}" (${c.projectName})`).join(", ")} — เปลี่ยนชื่อก่อน deploy`,
        );
      }
      linkNet = linkNetworkDockerName(project.linkNetwork);
      await docker.ensureNetwork(linkNet, { "platform.link": project.linkNetwork });
      safeLog(`[network] ต่อ link network "${project.linkNetwork}" (${linkNet})`);
    }

    const domainConfigs = loadProjectDomains(db, job.projectId);
    const compById = new Map(allComponents.map((c) => [c.id, c]));
    // domain ที่ไม่ได้ผูก component (หรือผูกกับตัวที่ไม่ใช่ web/ปิดอยู่) ไปที่ web ตัวแรกตาม position
    // web ตัวแรกใช้ service name ระดับ project เหมือนก่อนมี per-component routing — โปรเจกต์ที่มี web
    // ตัวเดียวจึงได้ label ชุดเดิมเป๊ะ และช่วง start-before-stop ไม่มี router ชี้ service คนละชื่อ
    const primaryWebId = components.find((c) => c.isWeb)?.id ?? null;
    const webIds = new Set(components.filter((c) => c.isWeb).map((c) => c.id));
    const domainsFor = (componentId: string) =>
      domainConfigs.filter((d) =>
        d.componentId && webIds.has(d.componentId)
          ? d.componentId === componentId
          : componentId === primaryWebId,
      );

    const unassignedVolumes = countUnassignedActiveVolumes(db, job.projectId);
    if (unassignedVolumes > 0) {
      safeLog(
        `[volume] ⚠️ มี ${unassignedVolumes} volume ที่ไม่ได้ผูก component — compose จะไม่ mount ` +
          "(สร้างใหม่ที่แท็บ Volumes โดยเลือก component)",
      );
    }

    for (const c of components) {
      const image = imageTags.get(c.id);
      if (!image) throw new AppError("BUILD_FAILED", `component "${c.name}" ไม่มี image`);

      // named volume ของ component — สร้างแบบ idempotent ก่อน create container (เหมือน single mode)
      // start-before-stop: container เก่าและใหม่ mount volume เดียวกันช่วงสั้น ๆ
      const volumes = loadComponentVolumes(db, job.projectId, c.id);
      for (const vol of volumes) {
        if (vol.accessMode === "single-writer") {
          safeLog(
            `[volume] ⚠️ "${c.name}": volume '${vol.dockerName}' (${vol.mountPath}) เป็น single-writer — ` +
              "container เก่าและใหม่อาจเขียนพร้อมกันชั่วคราวระหว่าง activation",
          );
        }
        await docker.createVolume({
          name: vol.dockerName,
          driver: vol.driver,
          labels: { "platform.managed": "true", "platform.volume_id": vol.id },
          ...(Object.keys(vol.driverOpts).length > 0 ? { opts: vol.driverOpts } : {}),
        });
      }
      const cName = componentContainerName(job.projectId, deploymentId, c.id, {
        projectName: project.name,
        componentName: c.name,
      });
      await docker.removeContainer(cName, { force: true });

      // web component แต่ละตัวได้ Traefik labels เฉพาะ domain ของตัวเอง + service ของตัวเอง
      const labels = {
        ...componentLabels(job.projectId, deploymentId, c.id),
        ...(c.isWeb
          ? buildTraefikLabels(domainsFor(c.id), job.projectId, {
              serviceName:
                c.id === primaryWebId
                  ? projectServiceName(job.projectId)
                  : componentServiceName(job.projectId, c.id),
            })
          : {}),
      };

      // ลำดับ env (ตัวหลัง override ตัวหน้า): project-wide → managed_ref inject → component-scoped
      // managed_ref dependency → ฉีด connection env (URL/host/port/user/pass/db) + ต้อง join
      // PROXY_NETWORK เพื่อ resolve ชื่อ container ของ service (service อยู่บน proxy net ไม่ใช่ per-deployment)
      const refDeps = c.dependsOn
        .map((d) => compById.get(d.id))
        .filter((dc): dc is DeployComponent => dc?.sourceKind === "managed_ref");
      let componentEnv = { ...envInject.runtimeEnv };
      for (const ref of refDeps) {
        const refEnv = await deps.buildManagedRefEnv(db, deps.masterKeys, ref);
        componentEnv = { ...componentEnv, ...refEnv };
      }
      // component-scoped env override ทับสุด (ผู้ใช้ตั้งเองเจาะจง component นี้)
      const scoped =
        scopedEnv.get(c.id) ??
        (await injectComponentEnv(db, deps.masterKeys, job.projectId, c.id, onLog));
      if (scoped.definedCount > 0 && scoped.failedKeys.length === scoped.definedCount) {
        throw new AppError(
          "ENV_INJECTION_FAILED",
          `env ของ component "${c.name}" ทั้ง ${scoped.definedCount} ตัวฉีดไม่ได้เลย ` +
            `(${scoped.failedKeys.join(", ")}) — กรอกค่าใหม่ในแท็บ Environment แล้ว deploy อีกครั้ง`,
        );
      }
      if (scoped.failedKeys.length > 0) {
        safeLog(
          `[env] ⚠️ component "${c.name}": ${scoped.failedKeys.length} จาก ${scoped.definedCount} ตัว ` +
            `decrypt ไม่ได้ (${scoped.failedKeys.join(", ")}) — ค่าเหล่านี้จะไม่ถูกส่งเข้า container`,
        );
      }
      componentEnv = { ...componentEnv, ...scoped.runtimeEnv };
      const needsProxy = c.isWeb || refDeps.length > 0;

      const { containerId } = await docker.createContainer({
        name: cName,
        image,
        labels,
        networkName,
        networkAliases: [c.name],
        // command เก็บเป็นบรรทัดเดียว — แยกเป็น argv ก่อนส่งเป็น CMD (ไม่ผ่าน shell)
        ...(c.command ? { cmd: splitCommandArgs(c.command) } : {}),
        cpuLimit: c.cpuLimit,
        memoryLimitMb: c.memoryLimitMb,
        memorySwapMb: c.memorySwapMb,
        ...(c.pidsLimit != null ? { pidsLimit: c.pidsLimit } : {}),
        capDropAll: c.capDropAll,
        noNewPrivileges: c.noNewPrivileges,
        restartPolicy: c.restartPolicy,
        env: componentEnv,
        ...(volumes.length > 0
          ? {
              volumes: volumes.map((v) => ({
                dockerName: v.dockerName,
                mountPath: v.mountPath,
                ...(v.readOnly ? { readOnly: true } : {}),
              })),
            }
          : {}),
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
      // link network: project อื่นใน link เดียวกันเรียก component นี้ด้วยชื่อ component
      if (linkNet) await docker.connectNetwork(linkNet, containerId, { aliases: [c.name] });
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
        .removeContainer(
          componentContainerName(job.projectId, deploymentId, c.id, {
            projectName: project.name,
            componentName: c.name,
          }),
          { force: true },
        )
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
