/**
 * Volume validation helpers — Phase 7
 *
 * validateMountPath ใช้ทั้งใน:
 * - control-api (ตรวจ input ก่อน store ลง DB)
 * - deploy-worker/safety.ts (ตรวจซ้ำใน assertContainerConfigSafe — defense-in-depth)
 */

import { VOLUME_SENSITIVE_PATHS } from "./constants";

export interface MountPathValidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * ตรวจ container mount path ให้ปลอดภัย:
 * - ต้องเป็น absolute Linux path (ขึ้นต้นด้วย /)
 * - ห้ามเป็น root filesystem /
 * - ห้ามมี .. (path traversal)
 * - ห้ามมี null byte
 * - ห้ามตรงกับหรือเริ่มด้วย VOLUME_SENSITIVE_PATHS
 */
export function validateMountPath(path: string): MountPathValidationResult {
  if (!path.startsWith("/")) {
    return { ok: false, reason: "mount path ต้องเป็น absolute path (ขึ้นต้นด้วย /)" };
  }
  if (path === "/") {
    return { ok: false, reason: "ห้าม mount root filesystem ทั้งหมด" };
  }
  if (path.includes("..")) {
    return { ok: false, reason: "mount path ห้ามมี .. (path traversal)" };
  }
  if (path.includes("\0")) {
    return { ok: false, reason: "mount path ห้ามมี null byte" };
  }

  const lower = path.toLowerCase();
  for (const forbidden of VOLUME_SENSITIVE_PATHS) {
    // ตรงเป๊ะ หรือ เป็น sub-path (เช่น /proc/cpuinfo)
    if (lower === forbidden || lower.startsWith(`${forbidden}/`)) {
      return { ok: false, reason: `ห้าม mount path ที่อ่อนไหว: ${forbidden}` };
    }
  }

  return { ok: true };
}
