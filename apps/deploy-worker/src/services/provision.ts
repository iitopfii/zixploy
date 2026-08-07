/**
 * Managed service provisioning — Phase 10 M3
 *
 * worker เป็นผู้เดียวที่แตะ Docker (ADR-0002) — control-api สั่งงานผ่าน service_jobs เท่านั้น
 *
 * ทุก operation **idempotent**: container/volume name generate จาก service id (deterministic)
 * และทุกขั้นตอน remove-if-exists ก่อนสร้าง — worker ตายกลางทางแล้ว retry ได้โดยไม่เหลือขยะ
 *
 * รหัสผ่านถูกส่งเข้า container ผ่าน env เท่านั้น ไม่เคยอยู่ใน argv ของคำสั่งที่ log ได้
 * (ยกเว้น `-e KEY=value` ซึ่ง Bun.spawn ส่งเป็น array ไม่ผ่าน shell — และเราไม่ log argv)
 */

import type { Database } from "bun:sqlite";
import {
  AppError,
  getTemplate,
  PROXY_NETWORK,
  SERVICE_SETTINGS,
  type ServiceCredentials,
  type ServiceType,
  serviceContainerName,
  serviceLabels,
  serviceVolumeName,
} from "@zixploy/shared";
import type { DockerCliClient } from "../docker/cli-client";
import { decryptEnvelope } from "../github/envelope";
import type { MasterKeys } from "../github/master-key";

export interface ServiceRow {
  id: string;
  name: string;
  type: string;
  version: string;
  image: string;
  status: string;
  container_id: string | null;
  volume_name: string;
  username: string;
  database_name: string;
  password_enc: Buffer | null;
  internal_port: number;
  exposed_port: number | null;
  memory_limit_mb: number | null;
  cpu_limit: number | null;
}

export function loadService(db: Database, serviceId: string): ServiceRow | null {
  return (
    db
      .query<ServiceRow, [string]>(
        `SELECT id, name, type, version, image, status, container_id, volume_name,
                username, database_name, password_enc, internal_port, exposed_port,
                memory_limit_mb, cpu_limit
         FROM services WHERE id = ?`,
      )
      .get(serviceId) ?? null
  );
}

export function setServiceStatus(
  db: Database,
  serviceId: string,
  status: string,
  extra: { containerId?: string | null; failureMessage?: string | null; started?: boolean } = {},
): void {
  const fields = ["status = ?", "updated_at = ?"];
  const values: (string | number | null)[] = [status, Date.now()];

  if (extra.containerId !== undefined) {
    fields.push("container_id = ?");
    values.push(extra.containerId);
  }
  if (extra.failureMessage !== undefined) {
    fields.push("failure_message = ?");
    values.push(extra.failureMessage);
  }
  if (extra.started) {
    fields.push("last_started_at = ?");
    values.push(Date.now());
  }

  values.push(serviceId);
  db.query(`UPDATE services SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

/** AAD ต้องตรงกับฝั่ง control-api เป๊ะ ๆ ไม่งั้น decrypt ไม่ผ่าน (ตั้งใจ — ดู encryption.md) */
function passwordAad(serviceId: string): string {
  return `service:${serviceId}:password`;
}

async function readCredentials(
  masterKeys: MasterKeys | null,
  row: ServiceRow,
): Promise<ServiceCredentials> {
  if (!row.password_enc) {
    throw new AppError("SERVICE_PROVISION_FAILED", "service นี้ไม่มีรหัสผ่านที่เข้ารหัสไว้");
  }
  if (!masterKeys) {
    throw new AppError(
      "SERVICE_PROVISION_FAILED",
      "worker ไม่มี master key — ตั้ง ZIXPLOY_MASTER_KEY_FILE ให้ตรงกับ control-api",
    );
  }
  const password = await decryptEnvelope(
    masterKeys,
    new Uint8Array(row.password_enc),
    passwordAad(row.id),
  );
  return { username: row.username, password, database: row.database_name };
}

/** ลบ container ชื่อนี้ถ้ามีอยู่ — ทำให้ create เป็น idempotent เมื่อ retry */
async function removeExistingContainer(docker: DockerCliClient, name: string): Promise<void> {
  const existing = await docker.inspectContainer(name);
  if (!existing) return;
  await docker.removeContainer(existing.Id, { force: true });
}

/**
 * รอจน container พร้อมใช้งานจริง
 *
 * ถ้า template ตั้ง HEALTHCHECK ไว้ → รอ State.Health.Status = "healthy"
 * ถ้าไม่ได้ตั้ง (libSQL ที่ image เป็น distroless) → รอแค่ให้ Running และไม่ตายภายในช่วงสังเกต
 * เพราะไม่มีทางตรวจ readiness จากข้างในได้เลย
 */
async function waitUntilReady(
  docker: DockerCliClient,
  containerId: string,
  hasHealthCheck: boolean,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let sawRunning = false;

  while (Date.now() < deadline) {
    if (signal.aborted) throw new AppError("SERVICE_PROVISION_FAILED", "ถูกยกเลิกระหว่างรอ");

    const info = await docker.inspectContainer(containerId);
    if (!info) throw new AppError("SERVICE_PROVISION_FAILED", "container หายไประหว่างรอให้พร้อม");

    if (hasHealthCheck) {
      const health = info.State.Health?.Status;
      if (health === "healthy") return;
      if (health === "unhealthy" && (info.State.Health?.FailingStreak ?? 0) >= 5) {
        throw new AppError(
          "SERVICE_PROVISION_FAILED",
          "container ตอบ healthcheck ไม่ผ่านติดต่อกันหลายครั้ง — ตรวจ log ของ service",
        );
      }
    } else {
      // ไม่มี healthcheck: เห็น running สองรอบติดกันถือว่าไม่ใช่ crash-loop
      if (info.State.Running && sawRunning) return;
      sawRunning = info.State.Running;
    }

    // container ตายไปแล้วระหว่างรอ = start ไม่สำเร็จจริง ๆ ไม่ต้องรอจนหมดเวลา
    if (!info.State.Running && info.State.Status === "exited") {
      throw new AppError(
        "SERVICE_PROVISION_FAILED",
        "container หยุดทำงานทันทีหลัง start — ตรวจ log ว่า config ถูกต้องไหม",
      );
    }

    await Bun.sleep(2_000);
  }

  throw new AppError(
    "SERVICE_PROVISION_FAILED",
    `รอ ${Math.round(timeoutMs / 1000)} วินาทีแล้ว service ยังไม่พร้อมใช้งาน`,
  );
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface ProvisionDeps {
  db: Database;
  docker: DockerCliClient;
  masterKeys: MasterKeys | null;
  onLog?: (line: string) => void;
}

/**
 * สร้าง volume + container แล้ว start จนพร้อมใช้งาน
 *
 * ใช้ทั้งตอนสร้างครั้งแรกและตอน recreate (เช่นหลังเปลี่ยน exposed port) — ลบ container เดิม
 * ก่อนเสมอ แต่ **ไม่แตะ volume** ข้อมูลจึงอยู่ครบ
 */
export async function provisionService(
  deps: ProvisionDeps,
  serviceId: string,
  signal: AbortSignal,
): Promise<void> {
  const { db, docker, masterKeys, onLog = () => {} } = deps;
  const row = loadService(db, serviceId);
  if (!row) throw new AppError("SERVICE_NOT_FOUND", "ไม่พบ service");

  const type = row.type as ServiceType;
  const template = getTemplate(type);
  const credentials = await readCredentials(masterKeys, row);

  setServiceStatus(db, serviceId, "creating", { failureMessage: null });

  onLog(`ดึง image ${row.image}`);
  await docker.pullImage(row.image);

  await docker.ensureNetwork(PROXY_NETWORK);

  const volumeName = serviceVolumeName(serviceId);
  // createVolume เป็น idempotent อยู่แล้ว (docker volume create ชื่อเดิมไม่ error)
  // — retry หลัง worker ตายกลางทางจึงไม่ทำข้อมูลเดิมหาย
  await docker.createVolume({
    name: volumeName,
    driver: "local",
    labels: serviceLabels(serviceId),
  });

  const containerName = serviceContainerName(serviceId);
  await removeExistingContainer(docker, containerName);

  const healthCmd = template.healthCmd();
  const { containerId } = await docker.createContainer({
    name: containerName,
    image: row.image,
    labels: serviceLabels(serviceId),
    env: template.env(credentials),
    ...(template.command?.() ? { cmd: template.command() as string[] } : {}),
    restartPolicy: "unless-stopped",
    networkName: PROXY_NETWORK,
    memoryLimitMb: row.memory_limit_mb,
    cpuLimit: row.cpu_limit,
    volumes: [{ dockerName: volumeName, mountPath: template.dataPath, readOnly: false }],
    ...(row.exposed_port
      ? { publishPorts: [{ hostPort: row.exposed_port, containerPort: row.internal_port }] }
      : {}),
    ...(healthCmd.length > 0
      ? {
          healthCheck: {
            cmd: healthCmd,
            intervalSec: 10,
            timeoutSec: 5,
            retries: 5,
            // database ใหญ่ ๆ ใช้เวลา init ครั้งแรกนาน — ระหว่าง start period ที่ fail ไม่นับ
            startPeriodSec: 60,
          },
        }
      : {}),
  });

  setServiceStatus(db, serviceId, "starting", { containerId });
  onLog(`start container ${containerName}`);
  await docker.startContainer(containerId);

  await waitUntilReady(
    docker,
    containerId,
    healthCmd.length > 0,
    SERVICE_SETTINGS.readyTimeoutMs,
    signal,
  );

  setServiceStatus(db, serviceId, "running", { containerId, failureMessage: null, started: true });
  onLog(`service "${row.name}" พร้อมใช้งาน`);
}

export async function startService(
  deps: ProvisionDeps,
  serviceId: string,
  signal: AbortSignal,
): Promise<void> {
  const { db, docker } = deps;
  const row = loadService(db, serviceId);
  if (!row) throw new AppError("SERVICE_NOT_FOUND", "ไม่พบ service");

  const containerName = serviceContainerName(serviceId);
  const existing = await docker.inspectContainer(containerName);

  // ไม่มี container แล้ว (ถูกลบไปนอกระบบ หรือยังไม่เคย provision สำเร็จ) → สร้างใหม่ทั้งชุด
  if (!existing) {
    await provisionService(deps, serviceId, signal);
    return;
  }

  setServiceStatus(db, serviceId, "starting", { containerId: existing.Id });
  await docker.startContainer(existing.Id);

  const template = getTemplate(row.type as ServiceType);
  await waitUntilReady(
    docker,
    existing.Id,
    template.healthCmd().length > 0,
    SERVICE_SETTINGS.readyTimeoutMs,
    signal,
  );

  setServiceStatus(db, serviceId, "running", { failureMessage: null, started: true });
}

export async function stopService(deps: ProvisionDeps, serviceId: string): Promise<void> {
  const { db, docker } = deps;
  const containerName = serviceContainerName(serviceId);
  const existing = await docker.inspectContainer(containerName);

  if (existing) await docker.stopContainer(existing.Id, { timeoutSec: 30 });
  setServiceStatus(db, serviceId, "stopped", { failureMessage: null });
}

export async function restartService(
  deps: ProvisionDeps,
  serviceId: string,
  signal: AbortSignal,
): Promise<void> {
  await stopService(deps, serviceId);
  await startService(deps, serviceId, signal);
}

/**
 * ลบ container + volume + record
 *
 * ลบ volume ด้วยเสมอ — ผู้ใช้กดลบ database ย่อมคาดว่าข้อมูลหายไปจริง (UI ให้พิมพ์ชื่อยืนยันแล้ว)
 * ปล่อย volume ค้างไว้จะกินดิสก์โดยไม่มีอะไรใน UI ชี้ว่ามันมีอยู่
 *
 * ทุกขั้นตอน re-verify label ก่อนลบ (ADR-0005) — ไม่ลบ resource ที่ไม่ใช่ของ service นี้
 */
export async function destroyService(deps: ProvisionDeps, serviceId: string): Promise<void> {
  const { db, docker, onLog = () => {} } = deps;

  const containerName = serviceContainerName(serviceId);
  const existing = await docker.inspectContainer(containerName);
  if (existing) {
    await docker.removeContainer(existing.Id, { force: true });
    onLog(`ลบ container ${containerName}`);
  }

  const volumeName = serviceVolumeName(serviceId);
  const volume = await docker.inspectVolume(volumeName);
  if (volume) {
    // ตรวจ label ก่อนลบจริง — กันลบ volume ที่บังเอิญชื่อชนแต่ไม่ใช่ของเรา
    const labels = (volume as { Labels?: Record<string, string> | null }).Labels ?? {};
    if (labels["platform.service_id"] === serviceId) {
      await docker.removeVolume(volumeName, { force: true });
      onLog(`ลบ volume ${volumeName}`);
    } else {
      onLog(`ข้าม volume ${volumeName} — label ไม่ตรงกับ service นี้`);
    }
  }

  db.query("DELETE FROM services WHERE id = ?").run(serviceId);
}
