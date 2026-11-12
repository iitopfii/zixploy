/**
 * Volume loader — Phase 7 M4
 *
 * โหลด active volumes ของ project จาก DB ก่อนสร้าง container
 * Worker เรียก docker.createVolume() ก่อน docker.createContainer() ทุกครั้ง (idempotent)
 */

import type { Database } from "bun:sqlite";

export interface VolumeConfig {
  id: string;
  /** Docker volume name — สร้างโดย volumeName() ห้ามเป็น user input */
  dockerName: string;
  /** Absolute Linux path ใน container */
  mountPath: string;
  accessMode: "shared-safe" | "single-writer";
  driver: string;
  /**
   * driver opts สำหรับ `docker volume create --opt` — bind mount เป็น
   * {type:"none", o:"bind", device:<host path>} ว่าง = named volume ปกติ
   * ค่าถูก validate แล้วที่ control-api ตอนสร้าง (validateHostPath) และแก้ทีหลังไม่ได้
   */
  driverOpts: Record<string, string>;
  readOnly: boolean;
}

/** parse driver_opts JSON จาก DB — คืน {} เมื่อ parse ไม่ได้ (ไม่ควรเกิดถ้า schema ถูกต้อง) */
export function parseDriverOpts(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // fallthrough → {}
  }
  return {};
}

/**
 * โหลด volumes ที่ lifecycle = 'active' ของ project เรียงตาม created_at
 * เฉพาะ active — detached/deletion_pending/deleted ไม่ mount
 */
interface VolumeRowForMount {
  id: string;
  docker_name: string;
  mount_path: string;
  access_mode: string;
  driver: string;
  driver_opts: string;
  read_only: number;
}

function toVolumeConfig(r: VolumeRowForMount): VolumeConfig {
  return {
    id: r.id,
    dockerName: r.docker_name,
    mountPath: r.mount_path,
    accessMode: r.access_mode as VolumeConfig["accessMode"],
    driver: r.driver,
    driverOpts: parseDriverOpts(r.driver_opts),
    readOnly: r.read_only === 1,
  };
}

/** active volume ของ component หนึ่งตัวในโปรเจกต์ compose (0.1.24) */
export function loadComponentVolumes(
  db: Database,
  projectId: string,
  componentId: string,
): VolumeConfig[] {
  return db
    .query<VolumeRowForMount, [string, string]>(
      `SELECT id, docker_name, mount_path, access_mode, driver, driver_opts, read_only
       FROM volumes
       WHERE project_id = ? AND component_id = ? AND lifecycle = 'active'
       ORDER BY created_at`,
    )
    .all(projectId, componentId)
    .map(toVolumeConfig);
}

/** volume ที่ active แต่ไม่ได้ผูก component — compose ไม่รู้จะ mount ที่ไหน (มักค้างจากก่อน promote) */
export function countUnassignedActiveVolumes(db: Database, projectId: string): number {
  return (
    db
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM volumes WHERE project_id = ? AND component_id IS NULL AND lifecycle = 'active'",
      )
      .get(projectId)?.n ?? 0
  );
}

export function loadActiveVolumes(db: Database, projectId: string): VolumeConfig[] {
  return db
    .query<
      {
        id: string;
        docker_name: string;
        mount_path: string;
        access_mode: string;
        driver: string;
        driver_opts: string;
        read_only: number;
      },
      [string]
    >(
      `SELECT id, docker_name, mount_path, access_mode, driver, driver_opts, read_only
       FROM volumes
       WHERE project_id = ? AND lifecycle = 'active'
       ORDER BY created_at`,
    )
    .all(projectId)
    .map((r) => ({
      id: r.id,
      dockerName: r.docker_name,
      mountPath: r.mount_path,
      accessMode: r.access_mode as VolumeConfig["accessMode"],
      driver: r.driver,
      driverOpts: parseDriverOpts(r.driver_opts),
      readOnly: r.read_only === 1,
    }));
}
