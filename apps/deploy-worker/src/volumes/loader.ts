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
  readOnly: boolean;
}

/**
 * โหลด volumes ที่ lifecycle = 'active' ของ project เรียงตาม created_at
 * เฉพาะ active — detached/deletion_pending/deleted ไม่ mount
 */
export function loadActiveVolumes(db: Database, projectId: string): VolumeConfig[] {
  return db
    .query<
      {
        id: string;
        docker_name: string;
        mount_path: string;
        access_mode: string;
        driver: string;
        read_only: number;
      },
      [string]
    >(
      `SELECT id, docker_name, mount_path, access_mode, driver, read_only
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
      readOnly: r.read_only === 1,
    }));
}
