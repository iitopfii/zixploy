/**
 * อ่าน component ของโปรเจกต์ compose + generation เก่า — read-only จากมุมมอง worker (Phase 18)
 *
 * worker อ่าน project_components/component_deps/deployment_containers ตรงจาก SQLite (ADR-0002)
 * แล้ว orchestrate.ts เอาไปสร้าง container จริง
 */

import type { Database } from "bun:sqlite";

export interface DeployComponent {
  id: string;
  name: string;
  role: string;
  sourceKind: "build" | "image" | "managed_ref";
  dockerfilePath: string | null;
  buildContext: string | null;
  targetStage: string | null;
  imageRef: string | null;
  managedServiceId: string | null;
  command: string | null;
  internalPort: number | null;
  isWeb: boolean;
  webPort: number | null;
  healthCheckPath: string | null;
  healthCheckIntervalSec: number;
  healthCheckTimeoutSec: number;
  healthCheckRetries: number;
  cpuLimit: number | null;
  memoryLimitMb: number | null;
  restartPolicy: "no" | "on-failure" | "always" | "unless-stopped";
  position: number;
  /** ชื่อ component ที่ตัวนี้ขึ้นกับ (resolved จาก component_deps) + เงื่อนไข */
  dependsOn: Array<{ id: string; condition: "started" | "healthy" }>;
}

interface ComponentRow {
  id: string;
  name: string;
  role: string;
  source_kind: string;
  dockerfile_path: string | null;
  build_context: string | null;
  target_stage: string | null;
  image_ref: string | null;
  managed_service_id: string | null;
  command: string | null;
  internal_port: number | null;
  is_web: number;
  web_port: number | null;
  health_check_path: string | null;
  health_check_interval_sec: number;
  health_check_timeout_sec: number;
  health_check_retries: number;
  cpu_limit: number | null;
  memory_limit_mb: number | null;
  restart_policy: string;
  position: number;
}

/** component ทั้งหมดที่ enabled ของโปรเจกต์ พร้อม dependency (เรียงตาม position) */
export function loadDeployComponents(db: Database, projectId: string): DeployComponent[] {
  const rows = db
    .query<ComponentRow, [string]>(
      `SELECT id, name, role, source_kind, dockerfile_path, build_context, target_stage, image_ref,
              managed_service_id, command, internal_port, is_web, web_port, health_check_path,
              health_check_interval_sec, health_check_timeout_sec, health_check_retries,
              cpu_limit, memory_limit_mb, restart_policy, position
         FROM project_components
        WHERE project_id = ? AND enabled = 1
        ORDER BY position, created_at`,
    )
    .all(projectId);

  const deps = db
    .query<{ component_id: string; depends_on_component_id: string; condition: string }, [string]>(
      "SELECT component_id, depends_on_component_id, condition FROM component_deps WHERE project_id = ?",
    )
    .all(projectId);
  const depMap = new Map<string, Array<{ id: string; condition: "started" | "healthy" }>>();
  for (const d of deps) {
    const list = depMap.get(d.component_id) ?? [];
    list.push({ id: d.depends_on_component_id, condition: d.condition as "started" | "healthy" });
    depMap.set(d.component_id, list);
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role,
    sourceKind: r.source_kind as DeployComponent["sourceKind"],
    dockerfilePath: r.dockerfile_path,
    buildContext: r.build_context,
    targetStage: r.target_stage,
    imageRef: r.image_ref,
    managedServiceId: r.managed_service_id,
    command: r.command,
    internalPort: r.internal_port,
    isWeb: r.is_web === 1,
    webPort: r.web_port,
    healthCheckPath: r.health_check_path,
    healthCheckIntervalSec: r.health_check_interval_sec,
    healthCheckTimeoutSec: r.health_check_timeout_sec,
    healthCheckRetries: r.health_check_retries,
    cpuLimit: r.cpu_limit,
    memoryLimitMb: r.memory_limit_mb,
    restartPolicy: r.restart_policy as DeployComponent["restartPolicy"],
    position: r.position,
    dependsOn: depMap.get(r.id) ?? [],
  }));
}

export interface PreviousContainer {
  componentId: string;
  containerId: string;
}

/**
 * container ของ generation ก่อนหน้า (deployment ที่ succeeded ล่าสุด) — ใช้ตอน activate เพื่อหยุด
 * ของเก่าหลังของใหม่ healthy ครบ (ADR-0004 start-before-stop สำหรับหลาย container)
 */
export function loadPreviousGenerationContainers(
  db: Database,
  projectId: string,
): PreviousContainer[] {
  const prev = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM deployments WHERE project_id = ? AND status = 'succeeded' ORDER BY finished_at DESC LIMIT 1",
    )
    .get(projectId);
  if (!prev) return [];
  return db
    .query<{ component_id: string; container_id: string | null }, [string]>(
      "SELECT component_id, container_id FROM deployment_containers WHERE deployment_id = ?",
    )
    .all(prev.id)
    .filter((r): r is { component_id: string; container_id: string } => r.container_id != null)
    .map((r) => ({ componentId: r.component_id, containerId: r.container_id }));
}

/** deployment_id ของ generation ก่อนหน้า (ใช้หา network เก่าไปลบ) */
export function previousDeploymentId(db: Database, projectId: string): string | null {
  const row = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM deployments WHERE project_id = ? AND status = 'succeeded' ORDER BY finished_at DESC LIMIT 1",
    )
    .get(projectId);
  return row?.id ?? null;
}

/** บันทึก container ที่สร้างต่อ component ต่อ deployment (แหล่งความจริงของ generation ปัจจุบัน) */
export function recordDeploymentContainer(
  db: Database,
  deploymentId: string,
  componentId: string,
  fields: { containerId: string; imageTag: string | null; status: string },
): void {
  db.query(
    `INSERT INTO deployment_containers (deployment_id, component_id, container_id, image_tag, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(deployment_id, component_id) DO UPDATE SET
       container_id = excluded.container_id, image_tag = excluded.image_tag,
       status = excluded.status, started_at = excluded.started_at`,
  ).run(deploymentId, componentId, fields.containerId, fields.imageTag, fields.status, Date.now());
}
