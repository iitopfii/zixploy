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

const SELECT_COLUMNS = `id, dockerfile_path, build_context, target_stage, internal_port,
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

/** อัปเดต project.status — ใช้เฉพาะตอน activate (running) และ stop (stopped) */
export function setProjectStatus(
  db: Database,
  projectId: string,
  status: "running" | "stopped" | "failed",
): void {
  db.query("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    Date.now(),
    projectId,
  );
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
