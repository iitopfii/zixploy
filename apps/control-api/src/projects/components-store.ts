/**
 * Project components storage — multi-container (compose-style) projects, Phase 18
 *
 * component = หนึ่ง container ในโปรเจกต์ compose (web / worker / cache / …) — control-api เขียน
 * แถว project_components + component_deps เท่านั้น; worker orchestrator เป็นคนอ่านไปสร้าง container
 * จริงตอน deploy (ADR-0002) โมดูลนี้ไม่แตะ Docker เลย
 *
 * ของเดิม (mode='single') ไม่มี component row — ฟีเจอร์นี้ opt-in ล้วน
 */

import type { Database } from "bun:sqlite";
import {
  AppError,
  type ComponentRole,
  type ComponentSourceKind,
  type DepCondition,
  isComponentName,
  ulid,
  validateImageRef,
} from "@zixploy/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComponentRow {
  id: string;
  project_id: string;
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
  exposed_port: number | null;
  health_check_path: string | null;
  health_check_interval_sec: number;
  health_check_timeout_sec: number;
  health_check_retries: number;
  cpu_limit: number | null;
  memory_limit_mb: number | null;
  restart_policy: string;
  position: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface ComponentDep {
  componentId: string;
  name: string;
  condition: DepCondition;
}

export interface ComponentDto {
  id: string;
  projectId: string;
  name: string;
  role: ComponentRole;
  sourceKind: ComponentSourceKind;
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
  cpuLimit: number | null;
  memoryLimitMb: number | null;
  restartPolicy: string;
  position: number;
  enabled: boolean;
  dependsOn: ComponentDep[];
  createdAt: number;
  updatedAt: number;
}

export interface ComponentInput {
  name: string;
  role?: ComponentRole;
  sourceKind: ComponentSourceKind;
  dockerfilePath?: string | null;
  buildContext?: string | null;
  targetStage?: string | null;
  imageRef?: string | null;
  managedServiceId?: string | null;
  command?: string | null;
  internalPort?: number | null;
  isWeb?: boolean;
  webPort?: number | null;
  healthCheckPath?: string | null;
  cpuLimit?: number | null;
  memoryLimitMb?: number | null;
  restartPolicy?: string;
  /** อ้าง component อื่นด้วย "ชื่อ" (เหมือน compose) — resolve เป็น id ภายใน */
  dependsOn?: Array<{ name: string; condition?: DepCondition }>;
}

const SELECT_ALL = `
  id, project_id, name, role, source_kind, dockerfile_path, build_context, target_stage,
  image_ref, managed_service_id, command, internal_port, is_web, web_port, exposed_port,
  health_check_path, health_check_interval_sec, health_check_timeout_sec, health_check_retries,
  cpu_limit, memory_limit_mb, restart_policy, position, enabled, created_at, updated_at
`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function loadDeps(db: Database, projectId: string): Map<string, ComponentDep[]> {
  const rows = db
    .query<
      {
        component_id: string;
        depends_on_component_id: string;
        dep_name: string;
        condition: string;
      },
      [string]
    >(
      `SELECT d.component_id, d.depends_on_component_id, c.name AS dep_name, d.condition
         FROM component_deps d
         JOIN project_components c ON c.id = d.depends_on_component_id
        WHERE d.project_id = ?`,
    )
    .all(projectId);
  const map = new Map<string, ComponentDep[]>();
  for (const r of rows) {
    const list = map.get(r.component_id) ?? [];
    list.push({
      componentId: r.depends_on_component_id,
      name: r.dep_name,
      condition: r.condition as DepCondition,
    });
    map.set(r.component_id, list);
  }
  return map;
}

export function toDto(row: ComponentRow, deps: ComponentDep[]): ComponentDto {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    role: row.role as ComponentRole,
    sourceKind: row.source_kind as ComponentSourceKind,
    dockerfilePath: row.dockerfile_path,
    buildContext: row.build_context,
    targetStage: row.target_stage,
    imageRef: row.image_ref,
    managedServiceId: row.managed_service_id,
    command: row.command,
    internalPort: row.internal_port,
    isWeb: row.is_web === 1,
    webPort: row.web_port,
    healthCheckPath: row.health_check_path,
    cpuLimit: row.cpu_limit,
    memoryLimitMb: row.memory_limit_mb,
    restartPolicy: row.restart_policy,
    position: row.position,
    enabled: row.enabled === 1,
    dependsOn: deps,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listComponents(db: Database, projectId: string): ComponentDto[] {
  const rows = db
    .query<ComponentRow, [string]>(
      `SELECT ${SELECT_ALL} FROM project_components WHERE project_id = ? ORDER BY position, created_at`,
    )
    .all(projectId);
  const deps = loadDeps(db, projectId);
  return rows.map((r) => toDto(r, deps.get(r.id) ?? []));
}

export function getComponentRow(
  db: Database,
  projectId: string,
  componentId: string,
): ComponentRow | null {
  return (
    db
      .query<ComponentRow, [string, string]>(
        `SELECT ${SELECT_ALL} FROM project_components WHERE id = ? AND project_id = ?`,
      )
      .get(componentId, projectId) ?? null
  );
}

export function requireComponent(
  db: Database,
  projectId: string,
  componentId: string,
): ComponentRow {
  const row = getComponentRow(db, projectId, componentId);
  if (!row) throw new AppError("COMPONENT_NOT_FOUND", "ไม่พบ component นี้");
  return row;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const RESTART_POLICIES = new Set(["no", "on-failure", "always", "unless-stopped"]);

function validatePort(value: number | null | undefined, field: string): void {
  if (value == null) return;
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new AppError("COMPONENT_INVALID", `${field} ต้องอยู่ระหว่าง 1-65535`, { field });
  }
}

/** ตรวจ field ตาม source_kind + web + limits — โยน COMPONENT_INVALID เมื่อผิด */
function validateInput(db: Database, input: ComponentInput): void {
  if (!isComponentName(input.name)) {
    throw new AppError(
      "COMPONENT_INVALID",
      "ชื่อ component ต้องเป็น DNS label: ขึ้นต้นด้วยตัวอักษรพิมพ์เล็ก, ใช้ a-z 0-9 - ยาวไม่เกิน 31 ตัว",
      { field: "name" },
    );
  }

  if (input.sourceKind === "image") {
    if (!input.imageRef) {
      throw new AppError("COMPONENT_INVALID", "source แบบ image ต้องระบุ imageRef", {
        field: "imageRef",
      });
    }
    const check = validateImageRef(input.imageRef);
    if (!check.ok) {
      throw new AppError("COMPONENT_INVALID", check.reason ?? "imageRef ไม่ถูกต้อง", {
        field: "imageRef",
      });
    }
  } else if (input.sourceKind === "managed_ref") {
    if (!input.managedServiceId) {
      throw new AppError("COMPONENT_INVALID", "source แบบ managed_ref ต้องระบุ managedServiceId", {
        field: "managedServiceId",
      });
    }
    const svc = db
      .query<{ id: string }, [string]>("SELECT id FROM services WHERE id = ?")
      .get(input.managedServiceId);
    if (!svc) {
      throw new AppError("COMPONENT_INVALID", "ไม่พบ managed service ที่อ้างถึง", {
        field: "managedServiceId",
      });
    }
  }
  // source_kind='build' ไม่มี field บังคับ (dockerfile_path/build_context มี default)

  if (input.isWeb && input.webPort == null) {
    throw new AppError("COMPONENT_INVALID", "component ที่เป็น web ต้องระบุ webPort", {
      field: "webPort",
    });
  }
  validatePort(input.webPort, "webPort");
  validatePort(input.internalPort, "internalPort");

  if (input.cpuLimit != null && input.cpuLimit <= 0) {
    throw new AppError("COMPONENT_INVALID", "cpuLimit ต้องมากกว่า 0", { field: "cpuLimit" });
  }
  if (input.memoryLimitMb != null && input.memoryLimitMb <= 0) {
    throw new AppError("COMPONENT_INVALID", "memoryLimitMb ต้องมากกว่า 0", {
      field: "memoryLimitMb",
    });
  }
  if (input.restartPolicy != null && !RESTART_POLICIES.has(input.restartPolicy)) {
    throw new AppError("COMPONENT_INVALID", "restartPolicy ไม่ถูกต้อง", { field: "restartPolicy" });
  }
}

// ---------------------------------------------------------------------------
// Dependency DAG
// ---------------------------------------------------------------------------

/** map ชื่อ→id ของ component ทุกตัวในโปรเจกต์ */
function nameToId(db: Database, projectId: string): Map<string, string> {
  const rows = db
    .query<{ id: string; name: string }, [string]>(
      "SELECT id, name FROM project_components WHERE project_id = ?",
    )
    .all(projectId);
  return new Map(rows.map((r) => [r.name, r.id]));
}

/** จะเกิด cycle ไหมถ้า component `fromId` ขึ้นกับ `targetIds` — DFS จาก target กลับมาหา from */
function wouldCycle(db: Database, projectId: string, fromId: string, targetIds: string[]): boolean {
  const edges = db
    .query<{ component_id: string; depends_on_component_id: string }, [string]>(
      "SELECT component_id, depends_on_component_id FROM component_deps WHERE project_id = ?",
    )
    .all(projectId);
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    // ข้าม edge เดิมของ fromId — เรากำลังจะเขียนทับด้วย targetIds
    if (e.component_id === fromId) continue;
    const list = adj.get(e.component_id) ?? [];
    list.push(e.depends_on_component_id);
    adj.set(e.component_id, list);
  }
  for (const t of targetIds) adj.set(fromId, [...(adj.get(fromId) ?? []), t]);

  // มี path จาก fromId กลับมา fromId ไหม
  const seen = new Set<string>();
  const stack = [...(adj.get(fromId) ?? [])];
  while (stack.length) {
    const n = stack.pop();
    if (n === undefined) continue;
    if (n === fromId) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(adj.get(n) ?? []));
  }
  return false;
}

/** เขียนทับ dependency ของ component หนึ่งตัว — resolve ชื่อ→id, ตรวจ ref/self/cycle */
export function setDependencies(
  db: Database,
  projectId: string,
  componentId: string,
  deps: Array<{ name: string; condition?: DepCondition }>,
): void {
  const names = nameToId(db, projectId);
  const targetIds: string[] = [];
  const conditions: DepCondition[] = [];
  for (const d of deps) {
    const targetId = names.get(d.name);
    if (!targetId) {
      throw new AppError("COMPONENT_DEP_INVALID", `depends_on อ้าง component ที่ไม่มี: "${d.name}"`);
    }
    if (targetId === componentId) {
      throw new AppError("COMPONENT_DEP_INVALID", "component ขึ้นกับตัวเองไม่ได้");
    }
    targetIds.push(targetId);
    conditions.push(d.condition ?? "started");
  }
  if (wouldCycle(db, projectId, componentId, targetIds)) {
    throw new AppError("COMPONENT_DEP_INVALID", "depends_on ทำให้เกิด dependency cycle");
  }

  db.query("DELETE FROM component_deps WHERE project_id = ? AND component_id = ?").run(
    projectId,
    componentId,
  );
  const insert = db.query(
    "INSERT INTO component_deps (project_id, component_id, depends_on_component_id, condition) VALUES (?, ?, ?, ?)",
  );
  for (let i = 0; i < targetIds.length; i++) {
    insert.run(projectId, componentId, targetIds[i] as string, conditions[i] as string);
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function createComponent(
  db: Database,
  projectId: string,
  input: ComponentInput,
): ComponentDto {
  validateInput(db, input);

  const id = ulid();
  const now = Date.now();
  const nextPos =
    (db
      .query<{ m: number | null }, [string]>(
        "SELECT MAX(position) AS m FROM project_components WHERE project_id = ?",
      )
      .get(projectId)?.m ?? -1) + 1;

  try {
    db.query(
      `INSERT INTO project_components
         (id, project_id, name, role, source_kind, dockerfile_path, build_context, target_stage,
          image_ref, managed_service_id, command, internal_port, is_web, web_port,
          health_check_path, cpu_limit, memory_limit_mb, restart_policy, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      projectId,
      input.name,
      input.role ?? "app",
      input.sourceKind,
      input.dockerfilePath ?? (input.sourceKind === "build" ? "Dockerfile" : null),
      input.buildContext ?? (input.sourceKind === "build" ? "." : null),
      input.targetStage ?? null,
      input.imageRef ?? null,
      input.managedServiceId ?? null,
      input.command ?? null,
      input.internalPort ?? null,
      input.isWeb ? 1 : 0,
      input.webPort ?? null,
      input.healthCheckPath ?? null,
      input.cpuLimit ?? null,
      input.memoryLimitMb ?? null,
      input.restartPolicy ?? "unless-stopped",
      nextPos,
      now,
      now,
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      throw new AppError(
        "COMPONENT_DUPLICATE_NAME",
        `ชื่อ component "${input.name}" ถูกใช้แล้วในโปรเจกต์นี้`,
      );
    }
    throw err;
  }

  if (input.dependsOn && input.dependsOn.length > 0) {
    setDependencies(db, projectId, id, input.dependsOn);
  }

  return toDto(requireComponent(db, projectId, id), loadDeps(db, projectId).get(id) ?? []);
}

export interface ComponentUpdate {
  name?: string;
  role?: ComponentRole;
  command?: string | null;
  internalPort?: number | null;
  isWeb?: boolean;
  webPort?: number | null;
  healthCheckPath?: string | null;
  cpuLimit?: number | null;
  memoryLimitMb?: number | null;
  restartPolicy?: string;
  enabled?: boolean;
  dockerfilePath?: string | null;
  buildContext?: string | null;
  targetStage?: string | null;
  imageRef?: string | null;
  dependsOn?: Array<{ name: string; condition?: DepCondition }>;
}

export function updateComponent(
  db: Database,
  projectId: string,
  componentId: string,
  update: ComponentUpdate,
): ComponentDto {
  const row = requireComponent(db, projectId, componentId);

  // ประกอบ input เต็มจาก row เดิม + update เพื่อ validate ทั้งชุด (source_kind ไม่ให้เปลี่ยน)
  const merged: ComponentInput = {
    name: update.name ?? row.name,
    role: (update.role ?? row.role) as ComponentRole,
    sourceKind: row.source_kind as ComponentSourceKind,
    dockerfilePath: update.dockerfilePath ?? row.dockerfile_path,
    buildContext: update.buildContext ?? row.build_context,
    targetStage: update.targetStage ?? row.target_stage,
    imageRef: update.imageRef ?? row.image_ref,
    managedServiceId: row.managed_service_id,
    command: update.command ?? row.command,
    internalPort: update.internalPort ?? row.internal_port,
    isWeb: update.isWeb ?? row.is_web === 1,
    webPort: update.webPort ?? row.web_port,
    healthCheckPath: update.healthCheckPath ?? row.health_check_path,
    cpuLimit: update.cpuLimit ?? row.cpu_limit,
    memoryLimitMb: update.memoryLimitMb ?? row.memory_limit_mb,
    restartPolicy: update.restartPolicy ?? row.restart_policy,
  };
  validateInput(db, merged);

  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  const set = (col: string, val: string | number | null) => {
    fields.push(`${col} = ?`);
    values.push(val);
  };
  if (update.name !== undefined) set("name", update.name);
  if (update.role !== undefined) set("role", update.role);
  if (update.command !== undefined) set("command", update.command);
  if (update.internalPort !== undefined) set("internal_port", update.internalPort);
  if (update.isWeb !== undefined) set("is_web", update.isWeb ? 1 : 0);
  if (update.webPort !== undefined) set("web_port", update.webPort);
  if (update.healthCheckPath !== undefined) set("health_check_path", update.healthCheckPath);
  if (update.cpuLimit !== undefined) set("cpu_limit", update.cpuLimit);
  if (update.memoryLimitMb !== undefined) set("memory_limit_mb", update.memoryLimitMb);
  if (update.restartPolicy !== undefined) set("restart_policy", update.restartPolicy);
  if (update.enabled !== undefined) set("enabled", update.enabled ? 1 : 0);
  if (update.dockerfilePath !== undefined) set("dockerfile_path", update.dockerfilePath);
  if (update.buildContext !== undefined) set("build_context", update.buildContext);
  if (update.targetStage !== undefined) set("target_stage", update.targetStage);
  if (update.imageRef !== undefined) set("image_ref", update.imageRef);

  if (fields.length > 0) {
    set("updated_at", Date.now());
    values.push(componentId);
    try {
      db.query(`UPDATE project_components SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE")) {
        throw new AppError("COMPONENT_DUPLICATE_NAME", "ชื่อ component นี้ถูกใช้แล้วในโปรเจกต์นี้");
      }
      throw err;
    }
  }

  if (update.dependsOn !== undefined) {
    setDependencies(db, projectId, componentId, update.dependsOn);
  }

  return toDto(
    requireComponent(db, projectId, componentId),
    loadDeps(db, projectId).get(componentId) ?? [],
  );
}

export function deleteComponent(db: Database, projectId: string, componentId: string): void {
  requireComponent(db, projectId, componentId);
  // component_deps ที่ชี้มา/ชี้ออกถูกลบด้วย ON DELETE CASCADE ของ FK
  db.query("DELETE FROM project_components WHERE id = ? AND project_id = ?").run(
    componentId,
    projectId,
  );
}

// ---------------------------------------------------------------------------
// Mode promotion
// ---------------------------------------------------------------------------

export function projectMode(db: Database, projectId: string): string {
  const row = db
    .query<{ mode: string }, [string]>("SELECT mode FROM projects WHERE id = ?")
    .get(projectId);
  return row?.mode ?? "single";
}

/**
 * เปลี่ยนโปรเจกต์เป็น mode='compose' — one-way (design: ปลด compose กลับไม่ได้ใน v1)
 * ต้องมี component อย่างน้อยหนึ่งตัว และมี web component อย่างน้อยหนึ่งตัว (ไม่งั้น Traefik ไม่มีอะไรให้ route)
 */
export function promoteToCompose(db: Database, projectId: string): void {
  const components = listComponents(db, projectId);
  if (components.length === 0) {
    throw new AppError("COMPOSE_PROMOTE_INVALID", "ต้องมี component อย่างน้อยหนึ่งตัวก่อนเปิดโหมด compose");
  }
  if (!components.some((c) => c.isWeb)) {
    throw new AppError(
      "COMPOSE_PROMOTE_INVALID",
      "ต้องมี component ที่เป็น web อย่างน้อยหนึ่งตัว (ตัวที่รับ traffic จากภายนอก)",
    );
  }
  db.query("UPDATE projects SET mode = 'compose', updated_at = ? WHERE id = ?").run(
    Date.now(),
    projectId,
  );
}
