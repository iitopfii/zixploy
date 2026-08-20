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

/**
 * คำนำหน้าชื่อ container ที่อ่านออกได้จากชื่อ project — เพื่อให้ `docker ps` บอกได้ทันทีว่า
 * container ไหนของ project ไหน (เดิมเห็นแต่ ULID ต้องเปิด dashboard เทียบ)
 *
 * เป็น **ส่วนตกแต่งล้วน ๆ** ไม่ใช่ตัวระบุตัวตน: ULID ที่ตามหลังยังเป็นตัวชี้ขาดเหมือนเดิม และ
 * การค้นหา/ลบ resource ยังใช้ label + container_id จาก DB เท่านั้น (ADR-0005) — rename project
 * จึงยังไม่กระทบ container ที่รันอยู่ ตรงตามเจตนาเดิมของ ADR
 *
 * คืน "" เมื่อชื่อไม่เหลืออักขระที่ Docker รับได้ (เช่นชื่อภาษาไทยล้วน) → ชื่อกลับไปเป็นรูปแบบเดิม
 */
export function projectSlug(projectName: string | null | undefined): string {
  if (!projectName) return "";
  return projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LEN)
    .replace(/-+$/g, "");
}

/** จำกัดความยาว slug — ชื่อ container รวม ULID หลายตัวอยู่แล้ว ไม่ควรยาวจนอ่านยากกว่าเดิม */
const SLUG_MAX_LEN = 16;

/** ต่อ slug ไว้หน้าชื่อ ถ้ามี — แยกเป็นฟังก์ชันเพื่อให้ทุกชื่อใช้กติกาเดียวกัน */
function withSlug(slug: string, base: string): string {
  return slug ? `${slug}-${base}` : base;
}

export function containerName(
  projectId: string,
  deploymentId: string,
  projectName?: string | null,
): string {
  assertUlid(projectId, "projectId");
  assertUlid(deploymentId, "deploymentId");
  return withSlug(
    projectSlug(projectName),
    `zx-${projectId.toLowerCase()}-${deploymentId.toLowerCase()}`,
  );
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

// ---------------------------------------------------------------------------
// Multi-container (compose-style) projects — Phase 18
//
// container/image/volume ของแต่ละ component ผูก componentId (ULID) เพิ่มเข้าไปในชื่อเดิม
// เพื่อให้หลาย container ในโปรเจกต์เดียวไม่ชนกัน · network เป็น per-deployment (ไม่ใช่ per-project)
// เพื่อให้ alias ของรุ่นเก่า/ใหม่แยก namespace กันตอน start-before-stop (ดู design doc)
// ---------------------------------------------------------------------------

/** container ของ component หนึ่งตัวใน deployment หนึ่งงาน */
export function componentContainerName(
  projectId: string,
  deploymentId: string,
  componentId: string,
  names?: { projectName?: string | null; componentName?: string | null },
): string {
  assertUlid(projectId, "projectId");
  assertUlid(deploymentId, "deploymentId");
  assertUlid(componentId, "componentId");
  // component name ผ่าน COMPONENT_NAME_RE (DNS label) มาแล้ว จึงปลอดภัยต่อ แต่ยัง slug ซ้ำกันเผื่อไว้
  const parts = [projectSlug(names?.projectName), projectSlug(names?.componentName)].filter(
    Boolean,
  );
  return withSlug(
    parts.join("-"),
    `zx-${projectId.toLowerCase()}-${deploymentId.toLowerCase()}-${componentId.toLowerCase()}`,
  );
}

/** image ที่ build จาก component (source_kind='build') */
export function componentImageName(
  projectId: string,
  componentId: string,
  commitSha: string,
  deploymentId: string,
): string {
  assertUlid(projectId, "projectId");
  assertUlid(componentId, "componentId");
  assertUlid(deploymentId, "deploymentId");
  if (!SHA_RE.test(commitSha)) throw new Error("commitSha must be a hex SHA");
  return `zixploy/${projectId.toLowerCase()}-${componentId.toLowerCase()}:${commitSha.slice(0, 7)}-${deploymentId.toLowerCase()}`;
}

/** network ส่วนตัวต่อ deployment — ทุก component ของ deployment นี้ join แล้วคุยกันด้วย alias */
export function deploymentNetworkName(projectId: string, deploymentId: string): string {
  assertUlid(projectId, "projectId");
  assertUlid(deploymentId, "deploymentId");
  return `zx-dnet-${projectId.toLowerCase()}-${deploymentId.toLowerCase()}`;
}

/** named volume ของ component หนึ่งตัว (แยกจาก volumeName เดิมด้วย componentId) */
export function componentVolumeName(
  projectId: string,
  componentId: string,
  volumeId: string,
): string {
  assertUlid(projectId, "projectId");
  assertUlid(componentId, "componentId");
  assertUlid(volumeId, "volumeId");
  return `zxvol-${projectId.toLowerCase()}-${componentId.toLowerCase()}-${volumeId.toLowerCase()}`;
}

/** Labels สำหรับ container/image ของ component — deploymentLabels + componentId */
export function componentLabels(
  projectId: string,
  deploymentId: string,
  componentId: string,
): Record<string, string> {
  assertUlid(componentId, "componentId");
  return {
    ...deploymentLabels(projectId, deploymentId),
    [LABELS.componentId]: componentId,
  };
}

/** Labels สำหรับ per-deployment network — reconciler ใช้กวาด network ที่ไม่มี deployment succeeded */
export function deploymentNetworkLabels(
  projectId: string,
  deploymentId: string,
): Record<string, string> {
  return deploymentLabels(projectId, deploymentId);
}
