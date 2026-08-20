/**
 * Volume validation helpers — Phase 7
 *
 * validateMountPath ใช้ทั้งใน:
 * - control-api (ตรวจ input ก่อน store ลง DB)
 * - deploy-worker/safety.ts (ตรวจซ้ำใน assertContainerConfigSafe — defense-in-depth)
 *
 * validateHostPath ใช้ใน control-api ตอนสร้าง volume แบบ bind mount (host path)
 */

import { VOLUME_HOST_SENSITIVE_PATHS, VOLUME_SENSITIVE_PATHS } from "./constants";

export interface MountPathValidationResult {
  ok: boolean;
  reason?: string;
}

export interface HostPathValidationResult {
  ok: boolean;
  reason?: string;
  /** error code ที่ผู้เรียกควรใช้ — แยกรูปแบบผิด (INVALID) ออกจาก path อันตราย (SENSITIVE) */
  code?: "VOLUME_INVALID_PATH" | "VOLUME_SENSITIVE_PATH";
  /** path หลัง normalize (เมื่อ ok) — เก็บค่านี้ลง driver_opts.device เพื่อให้ค่าใน DB สม่ำเสมอ */
  normalized?: string;
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

/**
 * ตรวจ host path สำหรับ bind mount (`driver_opts` = {type:"none", o:"bind", device:<path>}):
 * - ต้องเป็น absolute Linux path (ขึ้นต้นด้วย /)
 * - ห้ามมี null byte / ห้ามมี .. (path traversal — เช็คก่อน normalize เพื่อไม่ silently แก้ให้)
 * - normalize (ยุบ // ซ้อน, ตัด segment "." และ / ท้าย) แล้วห้ามเหลือเป็น root /
 * - ห้ามเป็นหรืออยู่ใต้ VOLUME_HOST_SENSITIVE_PATHS (list เข้มกว่าฝั่ง mount path — ดู constants.ts)
 *
 * @param extraForbidden path เพิ่มเติมที่รู้ได้ตอน runtime เท่านั้น — ปัจจุบันคือโฟลเดอร์ติดตั้งจริง
 *   เมื่อถูกย้ายออกจาก DEFAULT_INSTALL_DIR ด้วย ZIXPLOY_INSTALL_DIR (ค่า default อยู่ใน list แล้ว)
 *
 * ใช้ที่ control-api ตอน createVolume เท่านั้น — driver_opts เขียนได้ทางเดียวผ่าน create
 * (แก้ทีหลังไม่ได้เพราะ Docker ไม่รองรับเปลี่ยน volume opts หลังสร้าง) worker จึงเชื่อค่าใน DB ได้
 */
export function validateHostPath(
  path: string,
  extraForbidden: readonly string[] = [],
): HostPathValidationResult {
  if (!path.startsWith("/")) {
    return {
      ok: false,
      code: "VOLUME_INVALID_PATH",
      reason: "host path ต้องเป็น absolute path บนเซิร์ฟเวอร์ (ขึ้นต้นด้วย /)",
    };
  }
  if (path.includes("\0")) {
    return { ok: false, code: "VOLUME_INVALID_PATH", reason: "host path ห้ามมี null byte" };
  }
  if (path.includes("..")) {
    return {
      ok: false,
      code: "VOLUME_INVALID_PATH",
      reason: "host path ห้ามมี .. (path traversal)",
    };
  }

  // normalize แบบ Linux path ล้วน (ไม่ใช้ node:path — บนเครื่อง dev Windows จะได้ backslash ผิด)
  const segments = path.split("/").filter((s) => s !== "" && s !== ".");
  const normalized = `/${segments.join("/")}`;
  if (normalized === "/") {
    return {
      ok: false,
      code: "VOLUME_SENSITIVE_PATH",
      reason: "ห้าม bind mount root filesystem ของ host",
    };
  }

  const lower = normalized.toLowerCase();
  // extraForbidden รับ path ที่รู้ตอน runtime เท่านั้น (เช่น ZIXPLOY_INSTALL_DIR ที่ย้ายที่ไว้)
  // — normalize ให้เหมือนกันก่อนเทียบ ไม่งั้น "/srv/zixploy/" กับ "/srv/zixploy" จะไม่ตรงกัน
  const forbiddenPaths = [
    ...VOLUME_HOST_SENSITIVE_PATHS,
    ...extraForbidden
      .map((p) =>
        `/${p
          .split("/")
          .filter((s) => s !== "" && s !== ".")
          .join("/")}`.toLowerCase(),
      )
      .filter((p) => p !== "/"),
  ];
  for (const forbidden of forbiddenPaths) {
    // ตรงเป๊ะ หรือ เป็น sub-path (เช่น /etc/passwd, /var/lib/docker/volumes)
    if (lower === forbidden || lower.startsWith(`${forbidden}/`)) {
      return {
        ok: false,
        code: "VOLUME_SENSITIVE_PATH",
        reason: `ห้ามใช้ host path ที่อ่อนไหว: ${forbidden}`,
      };
    }
  }

  return { ok: true, normalized };
}
