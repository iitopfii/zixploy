/**
 * Container safety denylist — docs/threat-model.md section "Docker socket"
 *
 * ตรวจสองชั้น:
 * 1. assertContainerConfigSafe — validate ค่า params ระดับ semantic (ก่อนสร้าง argv)
 * 2. assertDockerArgsSafe — สแกน argv สุดท้ายก่อน spawn จริง เป็น defense-in-depth
 *    ชั้นสุดท้าย เผื่ออนาคต (Phase 7 volumes ฯลฯ) เพิ่ม field ใหม่แล้วลืมอัปเดตชั้นแรก
 *
 * ContainerCreateParams (docker/types.ts) ไม่มี field สำหรับ privileged/capabilities/
 * host bind mounts เลยตั้งแต่ระดับ type — "assert-by-construction" ชั้นแรกสุด
 */

import { AppError } from "@zixploy/shared";
import type { ContainerCreateParams } from "./types";

const FORBIDDEN_MOUNT_TARGETS = ["/var/run/docker.sock", "/proc", "/sys", "/dev"];

export function assertContainerConfigSafe(params: ContainerCreateParams): void {
  if (params.networkName === "host") {
    throw new AppError("VALIDATION_ERROR", "ห้ามใช้ host network mode", { field: "networkName" });
  }
  if (params.cpuLimit != null && params.cpuLimit <= 0) {
    throw new AppError("VALIDATION_ERROR", "cpuLimit ต้องมากกว่า 0", { field: "cpuLimit" });
  }
  if (params.memoryLimitMb != null && params.memoryLimitMb <= 0) {
    throw new AppError("VALIDATION_ERROR", "memoryLimitMb ต้องมากกว่า 0", { field: "memoryLimitMb" });
  }
  if (params.pidsLimit != null && params.pidsLimit <= 0) {
    throw new AppError("VALIDATION_ERROR", "pidsLimit ต้องมากกว่า 0", { field: "pidsLimit" });
  }
}

/**
 * สแกน argv ของ `docker create`/`docker run` ก่อน spawn จริง — ปฏิเสธ flag อันตรายทุกรูปแบบ
 * ไม่สนใจว่า caller ตั้งใจหรือไม่ตั้งใจใส่มา (defense-in-depth ชั้นสุดท้ายก่อนแตะ Docker จริง)
 */
export function assertDockerArgsSafe(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const lower = arg.toLowerCase();

    if (lower === "--privileged" || lower.startsWith("--privileged=")) {
      throw new AppError("VALIDATION_ERROR", "ห้ามใช้ --privileged");
    }
    if (
      lower === "--network=host" ||
      (lower === "--network" && (args[i + 1] ?? "").toLowerCase() === "host")
    ) {
      throw new AppError("VALIDATION_ERROR", "ห้ามใช้ host network mode");
    }
    if (lower === "--cap-add" || lower.startsWith("--cap-add=")) {
      throw new AppError("VALIDATION_ERROR", "ห้ามเพิ่ม Linux capabilities");
    }
    if (lower === "--pid=host" || (lower === "--pid" && (args[i + 1] ?? "") === "host")) {
      throw new AppError("VALIDATION_ERROR", "ห้ามใช้ host PID namespace");
    }
    if (lower === "-v" || lower === "--volume" || lower === "--mount") {
      const value = args[i + 1] ?? "";
      assertMountSafe(value);
    }
  }
}

function assertMountSafe(mountSpec: string): void {
  const normalized = mountSpec.replaceAll("\\", "/").toLowerCase();
  for (const forbidden of FORBIDDEN_MOUNT_TARGETS) {
    if (normalized.includes(forbidden)) {
      throw new AppError("VALIDATION_ERROR", `ห้าม mount path ที่อ่อนไหว: ${forbidden}`);
    }
  }
  // mount ทั้ง root filesystem ("/") เป็น source หรือ target — เช็คแบบตรง segment ไม่ใช่ substring
  // (กัน false positive กับ path ที่มี "/" เป็นส่วนหนึ่งตามปกติ)
  const parts = normalized.split(":");
  for (const part of parts.slice(0, 2)) {
    if (part === "/") {
      throw new AppError("VALIDATION_ERROR", "ห้าม mount root filesystem ทั้งหมด");
    }
  }
}
