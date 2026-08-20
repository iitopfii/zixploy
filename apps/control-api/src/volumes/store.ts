/**
 * Volume store — DB operations สำหรับ Phase 7
 *
 * ทุกฟังก์ชันรับ db เป็น param (ไม่ใช้ singleton) เพื่อ testability
 * ไม่มี Docker logic ที่นี่ — control-api ไม่แตะ Docker ตาม ADR-0002
 */

import type { Database } from "bun:sqlite";
import {
  AppError,
  DEFAULT_INSTALL_DIR,
  ulid,
  VOLUME_ALLOWED_DRIVERS,
  validateHostPath,
  validateMountPath,
  volumeName,
} from "@zixploy/shared";

/**
 * โฟลเดอร์ติดตั้งจริงที่ต้องกันไม่ให้ bind mount — DEFAULT_INSTALL_DIR อยู่ใน list กลางแล้ว
 * ที่นี่เพิ่มเฉพาะกรณีย้ายที่ด้วย ZIXPLOY_INSTALL_DIR ซึ่งรู้ได้ตอน runtime เท่านั้น
 */
function installDirsToProtect(): string[] {
  const configured = process.env.ZIXPLOY_INSTALL_DIR?.trim();
  return configured && configured !== DEFAULT_INSTALL_DIR ? [configured] : [];
}

export interface VolumeDto {
  id: string;
  projectId: string;
  displayName: string;
  dockerName: string;
  mountPath: string;
  accessMode: "shared-safe" | "single-writer";
  driver: string;
  driverOpts: Record<string, string>;
  /** host path เมื่อเป็น bind mount (derive จาก driverOpts.device) — null = Docker จัดการที่เก็บเอง */
  hostPath: string | null;
  readOnly: boolean;
  lifecycle: "active" | "detached" | "deletion_pending" | "deleted" | "error";
  lastAttachedAt: number | null;
  /** สาเหตุล่าสุดจาก reconciler (worker เขียน) — dashboard ใช้แสดงแทนข้อความ hardcode */
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface VolumeRow {
  id: string;
  project_id: string;
  display_name: string;
  docker_name: string;
  mount_path: string;
  access_mode: string;
  driver: string;
  driver_opts: string;
  read_only: number;
  lifecycle: string;
  last_attached_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function toDto(row: VolumeRow): VolumeDto {
  let driverOpts: Record<string, string> = {};
  try {
    driverOpts = JSON.parse(row.driver_opts) as Record<string, string>;
  } catch {
    // fallback to empty (ไม่ควรเกิด ถ้า DB schema ถูกต้อง)
  }
  // bind mount เมื่อ o มี "bind" และมี device — เผื่อ opts ที่ตั้งมือใน DB เป็น "bind,uid=1000"
  const isBind = (driverOpts.o ?? "").split(",").includes("bind") && !!driverOpts.device;
  return {
    id: row.id,
    projectId: row.project_id,
    displayName: row.display_name,
    dockerName: row.docker_name,
    mountPath: row.mount_path,
    accessMode: row.access_mode as VolumeDto["accessMode"],
    driver: row.driver,
    driverOpts,
    hostPath: isBind ? (driverOpts.device ?? null) : null,
    readOnly: row.read_only === 1,
    lifecycle: row.lifecycle as VolumeDto["lifecycle"],
    lastAttachedAt: row.last_attached_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listVolumes(db: Database, projectId: string): VolumeDto[] {
  return db
    .query<VolumeRow, [string]>(
      `SELECT id, project_id, display_name, docker_name, mount_path, access_mode, driver,
              driver_opts, read_only, lifecycle, last_attached_at, last_error, created_at, updated_at
       FROM volumes
       WHERE project_id = ? AND lifecycle != 'deleted'
       ORDER BY created_at`,
    )
    .all(projectId)
    .map(toDto);
}

export function getVolume(db: Database, volumeId: string): VolumeDto | null {
  const row = db
    .query<VolumeRow, [string]>(
      `SELECT id, project_id, display_name, docker_name, mount_path, access_mode, driver,
              driver_opts, read_only, lifecycle, last_attached_at, last_error, created_at, updated_at
       FROM volumes WHERE id = ?`,
    )
    .get(volumeId);
  return row ? toDto(row) : null;
}

export interface CreateVolumeParams {
  displayName: string;
  mountPath: string;
  accessMode?: "shared-safe" | "single-writer";
  driver?: string;
  readOnly?: boolean;
  /**
   * Host path สำหรับ bind mount — ตั้งได้เฉพาะตอนสร้าง (Docker ไม่รองรับเปลี่ยน volume opts
   * หลังสร้าง — updateVolume จึงห้ามรับ field นี้) ไม่ระบุ = Docker จัดการที่เก็บเอง
   */
  hostPath?: string;
}

export function createVolume(
  db: Database,
  projectId: string,
  params: CreateVolumeParams,
): VolumeDto {
  // Validate mount path
  const pathCheck = validateMountPath(params.mountPath);
  if (!pathCheck.ok) {
    throw new AppError("VOLUME_INVALID_PATH", pathCheck.reason ?? "invalid mount path", {
      field: "mountPath",
    });
  }

  // Validate driver
  const driver = params.driver ?? "local";
  if (!(VOLUME_ALLOWED_DRIVERS as readonly string[]).includes(driver)) {
    throw new AppError(
      "VOLUME_DRIVER_NOT_ALLOWED",
      `driver '${driver}' ไม่ได้รับอนุญาต — ใช้ได้เฉพาะ: ${VOLUME_ALLOWED_DRIVERS.join(", ")}`,
      { field: "driver", allowed: VOLUME_ALLOWED_DRIVERS },
    );
  }

  // Bind mount (host path) — Docker "local" driver รองรับผ่าน opts {type:none, o:bind, device:<path>}
  // validate + normalize ที่นี่ที่เดียว: driver_opts เขียนได้ทางเดียวผ่าน create เท่านั้น
  // (installDirsToProtect กันเคสย้ายโฟลเดอร์ติดตั้งไปที่อื่น — ค่า default อยู่ใน list กลางแล้ว)
  let driverOpts = "{}";
  if (params.hostPath !== undefined && params.hostPath !== "") {
    const hostCheck = validateHostPath(params.hostPath, installDirsToProtect());
    if (!hostCheck.ok) {
      throw new AppError(
        hostCheck.code ?? "VOLUME_INVALID_PATH",
        hostCheck.reason ?? "invalid host path",
        { field: "hostPath" },
      );
    }
    driverOpts = JSON.stringify({
      type: "none",
      o: "bind",
      device: hostCheck.normalized ?? params.hostPath,
    });
  }

  // ตรวจ duplicate mount path ใน project เดียวกัน (active volumes เท่านั้น)
  const dup = db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM volumes
       WHERE project_id = ? AND mount_path = ? AND lifecycle = 'active'`,
    )
    .get(projectId, params.mountPath);
  if (dup) {
    throw new AppError(
      "VOLUME_DUPLICATE_MOUNT",
      `mount path '${params.mountPath}' มี active volume อยู่แล้วใน project นี้`,
      { mountPath: params.mountPath },
    );
  }

  const id = ulid();
  const dockerName = volumeName(projectId, id);
  const now = Date.now();

  db.query(
    `INSERT INTO volumes
       (id, project_id, display_name, docker_name, mount_path, access_mode, driver,
        driver_opts, read_only, lifecycle, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    id,
    projectId,
    params.displayName,
    dockerName,
    params.mountPath,
    params.accessMode ?? "shared-safe",
    driver,
    driverOpts,
    params.readOnly ? 1 : 0,
    now,
    now,
  );

  return getVolume(db, id)!;
}

/** ไม่มี hostPath โดยตั้งใจ — docker volume opts เปลี่ยนหลังสร้างไม่ได้ ต้องลบแล้วสร้างใหม่เท่านั้น */
export interface UpdateVolumeParams {
  displayName?: string;
  mountPath?: string;
  accessMode?: "shared-safe" | "single-writer";
  readOnly?: boolean;
}

export function updateVolume(
  db: Database,
  volumeId: string,
  projectId: string,
  params: UpdateVolumeParams,
): VolumeDto {
  const vol = getVolume(db, volumeId);
  if (!vol || vol.projectId !== projectId) {
    throw new AppError("VOLUME_NOT_FOUND", "ไม่พบ volume นี้");
  }
  if (vol.lifecycle === "deleted") {
    throw new AppError("VOLUME_NOT_FOUND", "ไม่พบ volume นี้ (ถูกลบแล้ว)");
  }

  // Validate new mount path
  if (params.mountPath !== undefined) {
    const pathCheck = validateMountPath(params.mountPath);
    if (!pathCheck.ok) {
      throw new AppError("VOLUME_INVALID_PATH", pathCheck.reason ?? "invalid mount path", {
        field: "mountPath",
      });
    }
    // ตรวจ duplicate (ยกเว้น volume ตัวเอง)
    if (params.mountPath !== vol.mountPath) {
      const dup = db
        .query<{ id: string }, [string, string]>(
          `SELECT id FROM volumes
           WHERE project_id = ? AND mount_path = ? AND lifecycle = 'active'`,
        )
        .get(projectId, params.mountPath);
      if (dup) {
        throw new AppError(
          "VOLUME_DUPLICATE_MOUNT",
          `mount path '${params.mountPath}' มี active volume อยู่แล้วใน project นี้`,
          { mountPath: params.mountPath },
        );
      }
    }
  }

  const now = Date.now();
  const newDisplayName = params.displayName ?? vol.displayName;
  const newMountPath = params.mountPath ?? vol.mountPath;
  const newAccessMode = params.accessMode ?? vol.accessMode;
  const newReadOnly =
    params.readOnly !== undefined ? (params.readOnly ? 1 : 0) : vol.readOnly ? 1 : 0;

  db.query(
    `UPDATE volumes
     SET display_name = ?, mount_path = ?, access_mode = ?, read_only = ?, updated_at = ?
     WHERE id = ?`,
  ).run(newDisplayName, newMountPath, newAccessMode, newReadOnly, now, volumeId);

  return getVolume(db, volumeId)!;
}

/** lifecycle: active → detached (volume จะไม่ถูก mount บน deploy ถัดไป) */
export function detachVolume(db: Database, volumeId: string, projectId: string): VolumeDto {
  const vol = getVolume(db, volumeId);
  if (!vol || vol.projectId !== projectId) {
    throw new AppError("VOLUME_NOT_FOUND", "ไม่พบ volume นี้");
  }
  if (vol.lifecycle !== "active" && vol.lifecycle !== "error") {
    throw new AppError(
      "VOLUME_NOT_DETACHED",
      `volume อยู่ใน state '${vol.lifecycle}' ไม่สามารถ detach ได้`,
    );
  }

  db.query("UPDATE volumes SET lifecycle = 'detached', updated_at = ? WHERE id = ?").run(
    Date.now(),
    volumeId,
  );
  return getVolume(db, volumeId)!;
}

/**
 * lifecycle: detached → deletion_pending
 * Worker จะเรียก docker volume rm จริงใน reconcile loop
 * ต้อง detach ก่อน — ห้ามลบ active volume โดยตรง (อาจกำลัง mount อยู่)
 */
export function markVolumeForDeletion(db: Database, volumeId: string, projectId: string): void {
  const vol = getVolume(db, volumeId);
  if (!vol || vol.projectId !== projectId) {
    throw new AppError("VOLUME_NOT_FOUND", "ไม่พบ volume นี้");
  }
  if (vol.lifecycle === "active") {
    throw new AppError(
      "VOLUME_NOT_DETACHED",
      "ต้อง detach volume ก่อนจึงจะลบได้ (lifecycle ต้องเป็น detached)",
    );
  }
  if (vol.lifecycle === "deleted") {
    throw new AppError("VOLUME_NOT_FOUND", "ไม่พบ volume นี้ (ถูกลบแล้ว)");
  }

  db.query("UPDATE volumes SET lifecycle = 'deletion_pending', updated_at = ? WHERE id = ?").run(
    Date.now(),
    volumeId,
  );
}

/** ทำเครื่องหมาย lifecycle = 'error' (reconciler เรียกเมื่อ Docker volume ไม่มีอยู่จริง) */
export function setVolumeError(db: Database, volumeId: string): void {
  db.query("UPDATE volumes SET lifecycle = 'error', updated_at = ? WHERE id = ?").run(
    Date.now(),
    volumeId,
  );
}

/** ทำเครื่องหมาย lifecycle = 'deleted' (reconciler เรียกหลัง docker volume rm สำเร็จ) */
export function setVolumeDeleted(db: Database, volumeId: string): void {
  db.query("UPDATE volumes SET lifecycle = 'deleted', updated_at = ? WHERE id = ?").run(
    Date.now(),
    volumeId,
  );
}

/** อัป last_attached_at (worker เรียกหลัง createContainer สำเร็จ — Phase 7 M4) */
export function touchVolumeAttached(db: Database, volumeId: string): void {
  db.query("UPDATE volumes SET last_attached_at = ?, updated_at = ? WHERE id = ?").run(
    Date.now(),
    Date.now(),
    volumeId,
  );
}
