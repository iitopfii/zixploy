/**
 * Per-deployment isolated workspace — ที่ git clone ลงไปก่อน build (docs/threat-model.md section 3)
 *
 * แต่ละ deployment ได้ directory แยกภายใต้ workspacesDir()/<deploymentId>/ — ลบทิ้งเสมอทั้งก่อนเริ่ม
 * (idempotent retry หลัง worker crash) และหลังจบงาน (finally block ใน M6 pipeline)
 *
 * Path safety สองชั้น:
 * 1. assertSafeRelativePath — ตรวจ string เท่านั้น (ห้าม absolute, ห้าม "..") ก่อน join path ใด ๆ
 * 2. assertDockerfileWithinContext — ตรวจ realpath หลัง clone จริง เพื่อจับ symlink escape
 *    ที่ตรวจจาก string เฉย ๆ จับไม่ได้ (เช่น symlink ในโค้ดที่ clone มาชี้ออกนอก context)
 *
 * หมายเหตุ: assertSafeRelativePath ไม่ import จาก apps/control-api (worker ห้ามพึ่งพา control-api
 * ตาม ADR-0002) — เป็น implementation เดียวกันแบบ standalone
 */

import { mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { AppError } from "@zixploy/shared";

export function workspacesDir(): string {
  return process.env.ZIXPLOY_WORKSPACES_DIR ?? join(process.cwd(), "data", "workspaces");
}

export interface WorkspacePaths {
  /** root ของ workspace นี้ — ที่ git clone ลงไป */
  workspaceDir: string;
  /** build context ที่ resolve แล้ว (workspaceDir + project.buildContext) */
  buildContextDir: string;
}

/** path ต้องเป็น relative และห้ามออกนอก workspace (กัน path traversal ตั้งแต่ชั้น string) */
export function assertSafeRelativePath(value: string, field: string): void {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new AppError("WORKSPACE_ERROR", `${field} ต้องเป็น relative path`, { field });
  }
  if (normalized.split("/").includes("..")) {
    throw new AppError("WORKSPACE_ERROR", `${field} ต้องไม่มี ".."`, { field });
  }
}

/**
 * สร้าง workspace ว่างสำหรับ deployment — ลบของเก่าทิ้งก่อนเสมอ
 * (idempotent: retry หลัง worker crash กลางทางไม่ชนกับ clone ค้างจากรอบก่อน)
 */
export function createWorkspace(deploymentId: string, buildContext: string): WorkspacePaths {
  assertSafeRelativePath(buildContext, "buildContext");

  const workspaceDir = join(workspacesDir(), deploymentId);
  rmSync(workspaceDir, { recursive: true, force: true });
  mkdirSync(workspaceDir, { recursive: true });

  return { workspaceDir, buildContextDir: join(workspaceDir, buildContext) };
}

/** ลบ workspace ทิ้งเสมอหลังจบงาน (สำเร็จหรือล้มเหลว) — เรียกใน finally ของ pipeline */
export function removeWorkspace(deploymentId: string): void {
  rmSync(join(workspacesDir(), deploymentId), { recursive: true, force: true });
}

/** รวมขนาดไฟล์ทั้งหมดใน dir แบบ recursive (bytes) — ไม่ follow symlink กัน loop/escape */
function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += dirSizeBytes(full);
    } else if (entry.isFile()) {
      total += statSync(full).size;
    }
  }
  return total;
}

/**
 * ตรวจขนาดรวมของ workspace หลัง clone ก่อนเริ่ม build — threat-model.md "Build กิน...disk จน host ตาย"
 * (Phase 8 M1) เรียกหลัง clone เสร็จ ก่อน buildImage() เท่านั้น
 */
export function assertWorkspaceSizeWithinLimit(workspaceDir: string, maxMb: number): void {
  const sizeMb = dirSizeBytes(workspaceDir) / (1024 * 1024);
  if (sizeMb > maxMb) {
    throw new AppError(
      "WORKSPACE_TOO_LARGE",
      `workspace มีขนาด ${sizeMb.toFixed(1)}MB เกินขีดจำกัด ${maxMb}MB`,
      { sizeMb, maxMb },
    );
  }
}

/**
 * ตรวจว่า dockerfilePath อยู่ภายใน buildContextDir จริง โดยใช้ realpath (จับ symlink escape)
 * เรียกหลัง clone เสร็จเท่านั้น — buildContextDir ต้องมีอยู่จริงแล้ว
 * โยน AppError("DOCKERFILE_NOT_FOUND") ถ้า path ชี้ออกนอก context หรือไฟล์ไม่มีอยู่
 */
export function assertDockerfileWithinContext(
  buildContextDir: string,
  dockerfilePath: string,
): void {
  assertSafeRelativePath(dockerfilePath, "dockerfilePath");

  let contextReal: string;
  try {
    contextReal = realpathSync(buildContextDir);
  } catch {
    throw new AppError("DOCKERFILE_NOT_FOUND", `build context ไม่พบ: ${buildContextDir}`);
  }

  const candidate = resolve(buildContextDir, dockerfilePath);
  let resolvedReal: string;
  try {
    resolvedReal = realpathSync(candidate);
  } catch {
    throw new AppError("DOCKERFILE_NOT_FOUND", `ไม่พบ Dockerfile ที่ ${dockerfilePath}`);
  }

  if (resolvedReal !== contextReal && !resolvedReal.startsWith(contextReal + sep)) {
    throw new AppError(
      "DOCKERFILE_NOT_FOUND",
      `dockerfilePath ชี้ออกนอก build context (symlink escape ถูกปฏิเสธ): ${dockerfilePath}`,
    );
  }
}
