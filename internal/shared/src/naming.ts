/**
 * Docker resource naming — generate จาก immutable IDs เท่านั้น (ADR-0005)
 * ห้ามส่ง user input (เช่น project name) เข้าฟังก์ชันเหล่านี้
 */

import { LABELS, PROXY_NETWORK } from "./constants";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// 7-40 = git SHA-1 (เต็ม/ย่อ); ถึง 64 = sha256 ของเนื้อหา Dockerfile ที่วางเอง (Phase 13 —
// source แบบ dockerfile ไม่มี commit จริง control-api ใช้ hash เนื้อหาเป็น commitSha สังเคราะห์แทน)
const SHA_RE = /^[0-9a-f]{7,64}$/;

function assertUlid(value: string, field: string): void {
  if (!ULID_RE.test(value)) throw new Error(`${field} must be a ULID, got: ${value}`);
}

export function imageName(projectId: string, commitSha: string, deploymentId: string): string {
  assertUlid(projectId, "projectId");
  assertUlid(deploymentId, "deploymentId");
  if (!SHA_RE.test(commitSha)) throw new Error("commitSha must be a hex SHA");
  return `zixploy/${projectId.toLowerCase()}:${commitSha.slice(0, 7)}-${deploymentId.toLowerCase()}`;
}

export function containerName(projectId: string, deploymentId: string): string {
  assertUlid(projectId, "projectId");
  assertUlid(deploymentId, "deploymentId");
  return `zx-${projectId.toLowerCase()}-${deploymentId.toLowerCase()}`;
}

export function volumeName(projectId: string, volumeId: string): string {
  assertUlid(projectId, "projectId");
  assertUlid(volumeId, "volumeId");
  return `zxvol-${projectId.toLowerCase()}-${volumeId.toLowerCase()}`;
}

/**
 * Managed service (database) — Phase 10
 *
 * ไม่มี deploymentId เพราะ service ไม่ได้ build ใหม่ทุกครั้ง: container ผูกกับ service id
 * ตัวเดียวตลอดอายุ (recreate ใช้ชื่อเดิม ทำให้ remove-before-create เป็น idempotent)
 */
export function serviceContainerName(serviceId: string): string {
  assertUlid(serviceId, "serviceId");
  return `zxsvc-${serviceId.toLowerCase()}`;
}

export function serviceVolumeName(serviceId: string): string {
  assertUlid(serviceId, "serviceId");
  return `zxsvcvol-${serviceId.toLowerCase()}`;
}

/** Labels สำหรับ container/volume ของ managed service (ADR-0005) */
export function serviceLabels(serviceId: string): Record<string, string> {
  assertUlid(serviceId, "serviceId");
  return {
    [LABELS.managed]: "true",
    [LABELS.serviceId]: serviceId,
  };
}

export const proxyNetworkName = PROXY_NETWORK;

/** Labels สำหรับ container/image ของ deployment หนึ่งงาน */
export function deploymentLabels(projectId: string, deploymentId: string): Record<string, string> {
  assertUlid(projectId, "projectId");
  assertUlid(deploymentId, "deploymentId");
  return {
    [LABELS.managed]: "true",
    [LABELS.projectId]: projectId,
    [LABELS.deploymentId]: deploymentId,
  };
}

/** Labels สำหรับ named volume */
export function volumeLabels(projectId: string, volumeId: string): Record<string, string> {
  assertUlid(projectId, "projectId");
  assertUlid(volumeId, "volumeId");
  return {
    [LABELS.managed]: "true",
    [LABELS.projectId]: projectId,
    [LABELS.volumeId]: volumeId,
  };
}
