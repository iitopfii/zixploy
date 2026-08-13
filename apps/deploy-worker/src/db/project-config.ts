/**
 * อ่านค่า deploy/runtime config ของ project — read-only จากมุมมอง worker
 * (worker ไม่เคย UPDATE ตาราง projects ยกเว้น `status` ตอน activate/stop — ดู deployment-state.ts)
 */

import type { Database } from "bun:sqlite";

export interface ProjectConfig {
  id: string;
  dockerfilePath: string;
  buildContext: string;
  targetStage: string | null;
  internalPort: number | null;
  /** host port ที่ publish เข้า internalPort ตรง ๆ — null = route ผ่าน Traefik อย่างเดียว (Phase 14) */
  exposedPort: number | null;
  healthCheckPath: string | null;
  healthCheckIntervalSec: number;
  healthCheckTimeoutSec: number;
  healthCheckRetries: number;
  startCommand: string | null;
  cpuLimit: number | null;
  memoryLimitMb: number | null;
  restartPolicy: "no" | "on-failure" | "always" | "unless-stopped";
  deployTimeoutSec: number;
}

interface ProjectConfigRow {
  id: string;
  dockerfile_path: string;
  build_context: string;
  target_stage: string | null;
  internal_port: number | null;
  exposed_port: number | null;
  health_check_path: string | null;
  health_check_interval_sec: number;
  health_check_timeout_sec: number;
  health_check_retries: number;
  start_command: string | null;
  cpu_limit: number | null;
  memory_limit_mb: number | null;
  restart_policy: string;
  deploy_timeout_sec: number;
}

const SELECT_COLUMNS = `id, dockerfile_path, build_context, target_stage, internal_port, exposed_port,
  health_check_path, health_check_interval_sec, health_check_timeout_sec, health_check_retries,
  start_command, cpu_limit, memory_limit_mb, restart_policy, deploy_timeout_sec`;

export function loadProjectConfig(db: Database, projectId: string): ProjectConfig | null {
  const row = db
    .query<ProjectConfigRow, [string]>(`SELECT ${SELECT_COLUMNS} FROM projects WHERE id = ?`)
    .get(projectId);
  if (!row) return null;

  return {
    id: row.id,
    dockerfilePath: row.dockerfile_path,
    buildContext: row.build_context,
    targetStage: row.target_stage,
    internalPort: row.internal_port,
    exposedPort: row.exposed_port,
    healthCheckPath: row.health_check_path,
    healthCheckIntervalSec: row.health_check_interval_sec,
    healthCheckTimeoutSec: row.health_check_timeout_sec,
    healthCheckRetries: row.health_check_retries,
    startCommand: row.start_command,
    cpuLimit: row.cpu_limit,
    memoryLimitMb: row.memory_limit_mb,
    restartPolicy: row.restart_policy as "no" | "on-failure" | "always" | "unless-stopped",
    deployTimeoutSec: row.deploy_timeout_sec,
  };
}

/**
 * โหมดของ project — 'single' (pipeline เดิม) หรือ 'compose' (multi-container orchestrator, Phase 18)
 * dispatcher ใช้แยกทางว่า build job จะวิ่ง runBuildOrRollbackPipeline หรือ runComposePipeline
 * default 'single' ถ้าไม่พบ project (ให้ pipeline เดิมจัดการ error path ต่อเหมือนเดิม)
 */
export function loadProjectMode(db: Database, projectId: string): "single" | "compose" {
  const row = db
    .query<{ mode: string }, [string]>("SELECT mode FROM projects WHERE id = ?")
    .get(projectId);
  return row?.mode === "compose" ? "compose" : "single";
}

/**
 * อัปเดต project.status — ใช้เฉพาะตอน activate (running) และ stop (stopped)
 * เคลียร์ degraded_at ทุกครั้งที่มี lifecycle event ชัดเจน (Phase 8 M2) — เหตุการณ์ intentional
 * แบบนี้ทำให้ marker "container หายไปเฉย ๆ" ก่อนหน้าไม่มีความหมายแล้วไม่ว่าจะเป็นสถานะไหนก็ตาม
 */
export function setProjectStatus(
  db: Database,
  projectId: string,
  status: "running" | "stopped" | "failed",
): void {
  db.query("UPDATE projects SET status = ?, degraded_at = NULL, updated_at = ? WHERE id = ?").run(
    status,
    Date.now(),
    projectId,
  );
}

/** mark project ว่า active container หายไปจาก Docker ทั้งที่ status ยังเป็น 'running' (Phase 8 M2) */
export function markProjectDegraded(db: Database, projectId: string): boolean {
  const result = db
    .query(
      "UPDATE projects SET degraded_at = ? WHERE id = ? AND status = 'running' AND degraded_at IS NULL",
    )
    .run(Date.now(), projectId);
  return result.changes > 0;
}

/** container_id ของ deployment ที่ succeeded ล่าสุดของ project — ใช้ตอน activate (หา "ของเก่า") และ restart/stop */
export function findActiveContainerId(db: Database, projectId: string): string | null {
  const row = db
    .query<{ container_id: string | null }, [string]>(
      "SELECT container_id FROM deployments WHERE project_id = ? AND status = 'succeeded' ORDER BY finished_at DESC LIMIT 1",
    )
    .get(projectId);
  return row?.container_id ?? null;
}
