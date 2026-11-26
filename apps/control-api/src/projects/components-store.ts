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
  errorText,
  HEALTH_CHECK_LIMITS,
  isComponentName,
  isGitBranchName,
  isRepoFullName,
  splitCommandArgs,
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
  health_cmd: string | null;
  cpu_limit: number | null;
  memory_limit_mb: number | null;
  memory_swap_mb: number | null;
  pids_limit: number | null;
  cap_drop_all: number;
  no_new_privileges: number;
  restart_policy: string;
  position: number;
  enabled: number;
  repo_installation_id: string | null;
  /** github_installations.installation_id (ตัวเลขของ GitHub) — join มาใน SELECT_ALL */
  repo_installation_number: number | null;
  repo_full_name: string | null;
  repo_branch: string | null;
  created_at: number;
  updated_at: number;
}

/** repo/branch ของ build component เอง — null = ใช้ source ของ project */
export interface ComponentGitSource {
  /** GitHub installation ID (ตัวเลข) เหมือน body ของ PUT /projects/:id/source */
  installationId: number;
  repoFullName: string;
  branch: string;
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
  /** repo/branch ของตัวเอง (build เท่านั้น) — null = build จาก repo ของ project */
  gitSource: ComponentGitSource | null;
  imageRef: string | null;
  managedServiceId: string | null;
  command: string | null;
  internalPort: number | null;
  isWeb: boolean;
  webPort: number | null;
  healthCheckPath: string | null;
  /** วินาทีระหว่างการตรวจแต่ละครั้ง (HTTP health check และ Docker HEALTHCHECK) */
  healthCheckIntervalSec: number;
  /** timeout ต่อครั้ง (วินาที) */
  healthCheckTimeoutSec: number;
  /** จำนวนครั้งที่ตรวจก่อนถือว่า deploy ล้ม — service ที่ start ช้าต้องตั้งให้มากขึ้น */
  healthCheckRetries: number;
  /** คำสั่ง Docker HEALTHCHECK ในคอนเทนเนอร์ — จำเป็นเมื่อมี component อื่นรอตัวนี้แบบ condition='healthy' */
  healthCmd: string | null;
  cpuLimit: number | null;
  memoryLimitMb: number | null;
  /** --memory-swap (MB รวม RAM) — null = ค่าเริ่มต้นของ Docker */
  memorySwapMb: number | null;
  /** --pids-limit — null = 512 */
  pidsLimit: number | null;
  /** --cap-drop ALL */
  capDropAll: boolean;
  /** --security-opt no-new-privileges:true */
  noNewPrivileges: boolean;
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
  gitSource?: ComponentGitSource | null;
  imageRef?: string | null;
  managedServiceId?: string | null;
  command?: string | null;
  internalPort?: number | null;
  isWeb?: boolean;
  webPort?: number | null;
  healthCheckPath?: string | null;
  healthCheckIntervalSec?: number;
  healthCheckTimeoutSec?: number;
  healthCheckRetries?: number;
  healthCmd?: string | null;
  cpuLimit?: number | null;
  memoryLimitMb?: number | null;
  memorySwapMb?: number | null;
  pidsLimit?: number | null;
  capDropAll?: boolean;
  noNewPrivileges?: boolean;
  restartPolicy?: string;
  /** อ้าง component อื่นด้วย "ชื่อ" (เหมือน compose) — resolve เป็น id ภายใน */
  dependsOn?: Array<{ name: string; condition?: DepCondition }>;
}

const SELECT_ALL = `
  id, project_id, name, role, source_kind, dockerfile_path, build_context, target_stage,
  image_ref, managed_service_id, command, internal_port, is_web, web_port, exposed_port,
  health_check_path, health_check_interval_sec, health_check_timeout_sec, health_check_retries,
  health_cmd, cpu_limit, memory_limit_mb, memory_swap_mb, pids_limit, cap_drop_all, no_new_privileges,
  restart_policy, position, enabled, repo_installation_id, repo_full_name, repo_branch,
  (SELECT gi.installation_id FROM github_installations gi WHERE gi.id = repo_installation_id)
    AS repo_installation_number,
  created_at, updated_at
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
    gitSource:
      row.repo_full_name && row.repo_branch && row.repo_installation_number != null
        ? {
            installationId: row.repo_installation_number,
            repoFullName: row.repo_full_name,
            branch: row.repo_branch,
          }
        : null,
    imageRef: row.image_ref,
    managedServiceId: row.managed_service_id,
    command: row.command,
    internalPort: row.internal_port,
    isWeb: row.is_web === 1,
    webPort: row.web_port,
    healthCheckPath: row.health_check_path,
    healthCheckIntervalSec: row.health_check_interval_sec,
    healthCheckTimeoutSec: row.health_check_timeout_sec,
    healthCheckRetries: row.health_check_retries,
    healthCmd: row.health_cmd,
    cpuLimit: row.cpu_limit,
    memoryLimitMb: row.memory_limit_mb,
    memorySwapMb: row.memory_swap_mb,
    pidsLimit: row.pids_limit,
    capDropAll: row.cap_drop_all === 1,
    noNewPrivileges: row.no_new_privileges === 1,
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
  if (!row)
    throw new AppError("COMPONENT_NOT_FOUND", {
      th: "ไม่พบ component นี้",
      en: "Component not found",
    });
  return row;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const RESTART_POLICIES = new Set(["no", "on-failure", "always", "unless-stopped"]);

function validatePort(value: number | null | undefined, field: string): void {
  if (value == null) return;
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new AppError(
      "COMPONENT_INVALID",
      { th: `${field} ต้องอยู่ระหว่าง 1-65535`, en: `${field} must be between 1 and 65535` },
      { field },
    );
  }
}

/** รูปแบบ owner/repo + ชื่อ branch — route เรียกก่อนถาม GitHub เพื่อให้ input ผิดรูปได้ 422 ทันที */
export function assertGitSourceFormat(source: ComponentGitSource): void {
  if (!isRepoFullName(source.repoFullName)) {
    throw new AppError(
      "COMPONENT_INVALID",
      { th: "repository ต้องอยู่ในรูป owner/repo", en: "Repository must be in the form owner/repo" },
      {
        field: "gitSource.repoFullName",
      },
    );
  }
  if (!isGitBranchName(source.branch)) {
    throw new AppError(
      "COMPONENT_INVALID",
      { th: "ชื่อ branch ไม่ถูกต้อง", en: "Invalid branch name" },
      {
        field: "gitSource.branch",
      },
    );
  }
}

/** ตรวจ field ตาม source_kind + web + limits — โยน COMPONENT_INVALID เมื่อผิด */
/** ค่าเริ่มต้นเดียวกับ DEFAULT ของคอลัมน์ใน migration 0023 */
const DEFAULT_HEALTH_CHECK = { intervalSec: 5, timeoutSec: 30, retries: 3 } as const;

function validateInput(db: Database, input: ComponentInput): void {
  if (!isComponentName(input.name)) {
    throw new AppError(
      "COMPONENT_INVALID",
      {
        th: "ชื่อ component ต้องเป็น DNS label: ขึ้นต้นด้วยตัวอักษรพิมพ์เล็ก, ใช้ a-z 0-9 - ยาวไม่เกิน 31 ตัว",
        en: "Component name must be a DNS label: start with a lowercase letter, use a-z 0-9 -, at most 31 characters",
      },
      { field: "name" },
    );
  }

  if (input.sourceKind === "image") {
    if (!input.imageRef) {
      throw new AppError(
        "COMPONENT_INVALID",
        { th: "source แบบ image ต้องระบุ imageRef", en: "An image source requires imageRef" },
        {
          field: "imageRef",
        },
      );
    }
    const check = validateImageRef(input.imageRef);
    if (!check.ok) {
      throw new AppError("COMPONENT_INVALID", check.reasonText, { field: "imageRef" });
    }
  } else if (input.sourceKind === "managed_ref") {
    if (!input.managedServiceId) {
      throw new AppError(
        "COMPONENT_INVALID",
        {
          th: "source แบบ managed_ref ต้องระบุ managedServiceId",
          en: "A managed_ref source requires managedServiceId",
        },
        {
          field: "managedServiceId",
        },
      );
    }
    const svc = db
      .query<{ id: string }, [string]>("SELECT id FROM services WHERE id = ?")
      .get(input.managedServiceId);
    if (!svc) {
      throw new AppError(
        "COMPONENT_INVALID",
        { th: "ไม่พบ managed service ที่อ้างถึง", en: "Referenced managed service not found" },
        {
          field: "managedServiceId",
        },
      );
    }
  }
  // source_kind='build' ไม่มี field บังคับ (dockerfile_path/build_context มี default)
  if (input.command) {
    try {
      splitCommandArgs(input.command);
    } catch (err) {
      throw new AppError(
        "COMPONENT_INVALID",
        errorText(err, { th: "command ไม่ถูกต้อง", en: "Invalid command" }),
        {
          field: "command",
        },
      );
    }
  }
  for (const [field, value, lim] of [
    ["healthCheckIntervalSec", input.healthCheckIntervalSec, HEALTH_CHECK_LIMITS.intervalSec],
    ["healthCheckTimeoutSec", input.healthCheckTimeoutSec, HEALTH_CHECK_LIMITS.timeoutSec],
    ["healthCheckRetries", input.healthCheckRetries, HEALTH_CHECK_LIMITS.retries],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < lim.min || value > lim.max) {
      throw new AppError(
        "COMPONENT_INVALID",
        {
          th: `${field} ต้องเป็นจำนวนเต็ม ${lim.min}–${lim.max}`,
          en: `${field} must be an integer from ${lim.min} to ${lim.max}`,
        },
        {
          field,
        },
      );
    }
  }
  if (input.gitSource) {
    if (input.sourceKind !== "build") {
      throw new AppError(
        "COMPONENT_INVALID",
        {
          th: "ตั้ง repo แยกได้เฉพาะ component แบบ build",
          en: "A separate repo can only be set on a build component",
        },
        {
          field: "gitSource",
        },
      );
    }
    assertGitSourceFormat(input.gitSource);
  }

  if (input.isWeb && input.webPort == null) {
    throw new AppError(
      "COMPONENT_INVALID",
      { th: "component ที่เป็น web ต้องระบุ webPort", en: "A web component requires webPort" },
      {
        field: "webPort",
      },
    );
  }
  validatePort(input.webPort, "webPort");
  validatePort(input.internalPort, "internalPort");

  // health_cmd รันใน container ผ่าน CMD-SHELL (argv เดี่ยว) — กันความยาวเกิน + control char/newline
  // ที่จะทำให้ประกอบ docker args เพี้ยน (managed_ref ใช้ healthcheck ของ service เองจึงไม่ต้องตั้ง)
  if (input.healthCmd != null && input.healthCmd !== "") {
    if (input.healthCmd.length > 1024) {
      throw new AppError(
        "COMPONENT_INVALID",
        { th: "healthCmd ยาวเกิน 1024 ตัวอักษร", en: "healthCmd is longer than 1024 characters" },
        {
          field: "healthCmd",
        },
      );
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: กัน control char ใน argv โดยเจตนา
    if (/[\x00-\x1f\x7f]/.test(input.healthCmd)) {
      throw new AppError(
        "COMPONENT_INVALID",
        {
          th: "healthCmd ต้องไม่มี control character หรือขึ้นบรรทัดใหม่",
          en: "healthCmd must not contain control characters or line breaks",
        },
        {
          field: "healthCmd",
        },
      );
    }
  }

  if (input.cpuLimit != null && input.cpuLimit <= 0) {
    throw new AppError(
      "COMPONENT_INVALID",
      { th: "cpuLimit ต้องมากกว่า 0", en: "cpuLimit must be greater than 0" },
      { field: "cpuLimit" },
    );
  }
  if (input.memoryLimitMb != null && input.memoryLimitMb <= 0) {
    throw new AppError(
      "COMPONENT_INVALID",
      { th: "memoryLimitMb ต้องมากกว่า 0", en: "memoryLimitMb must be greater than 0" },
      {
        field: "memoryLimitMb",
      },
    );
  }
  // Docker: --memory-swap ใช้ได้เมื่อมี --memory และต้องไม่น้อยกว่า (ค่าเป็น RAM+swap รวมกัน)
  if (input.memorySwapMb != null) {
    if (input.memoryLimitMb == null) {
      throw new AppError(
        "COMPONENT_INVALID",
        {
          th: "ตั้ง memorySwapMb ได้เมื่อมี memoryLimitMb แล้วเท่านั้น",
          en: "memorySwapMb can only be set when memoryLimitMb is set",
        },
        {
          field: "memorySwapMb",
        },
      );
    }
    if (input.memorySwapMb < input.memoryLimitMb) {
      throw new AppError(
        "COMPONENT_INVALID",
        {
          th: "memorySwapMb คือ RAM + swap รวมกัน — ต้องไม่น้อยกว่า memoryLimitMb (เท่ากัน = ไม่ให้ swap)",
          en: "memorySwapMb is RAM plus swap combined. It must not be less than memoryLimitMb (equal means no swap)",
        },
        { field: "memorySwapMb" },
      );
    }
  }
  if (input.pidsLimit != null && (input.pidsLimit < 16 || input.pidsLimit > 32768)) {
    throw new AppError(
      "COMPONENT_INVALID",
      { th: "pidsLimit ต้องอยู่ระหว่าง 16–32768", en: "pidsLimit must be between 16 and 32768" },
      {
        field: "pidsLimit",
      },
    );
  }
  if (input.restartPolicy != null && !RESTART_POLICIES.has(input.restartPolicy)) {
    throw new AppError(
      "COMPONENT_INVALID",
      { th: "restartPolicy ไม่ถูกต้อง", en: "Invalid restartPolicy" },
      { field: "restartPolicy" },
    );
  }
}

/**
 * GitHub installation (ตัวเลข) → github_installations.id ภายใน — ต้องมีและ active
 * เก็บ ULID ภายในแบบเดียวกับ projects.installation_id เพื่อให้ uninstall/reinstall ตามแถวเดียวกัน
 */
function resolveInstallationRowId(db: Database, installationId: number): string {
  const row = db
    .query<{ id: string; status: string }, [number]>(
      "SELECT id, status FROM github_installations WHERE installation_id = ?",
    )
    .get(installationId);
  if (!row) {
    throw new AppError("INSTALLATION_NOT_FOUND", {
      th: "ไม่พบ GitHub installation นี้ในระบบ",
      en: "GitHub installation not found",
    });
  }
  if (row.status !== "active") {
    throw new AppError("GITHUB_UNAVAILABLE", {
      th: "GitHub installation ไม่ได้ active — reinstall หรือ unsuspend ก่อน",
      en: "GitHub installation is not active. Reinstall or unsuspend it first",
    });
  }
  return row.id;
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
      throw new AppError("COMPONENT_DEP_INVALID", {
        th: `depends_on อ้าง component ที่ไม่มี: "${d.name}"`,
        en: `depends_on refers to a component that does not exist: "${d.name}"`,
      });
    }
    if (targetId === componentId) {
      throw new AppError("COMPONENT_DEP_INVALID", {
        th: "component ขึ้นกับตัวเองไม่ได้",
        en: "A component cannot depend on itself",
      });
    }
    targetIds.push(targetId);
    conditions.push(d.condition ?? "started");
  }
  if (wouldCycle(db, projectId, componentId, targetIds)) {
    throw new AppError("COMPONENT_DEP_INVALID", {
      th: "depends_on ทำให้เกิด dependency cycle",
      en: "depends_on would create a dependency cycle",
    });
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
  const repoInstallationRowId = input.gitSource
    ? resolveInstallationRowId(db, input.gitSource.installationId)
    : null;

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
          health_check_path, health_check_interval_sec, health_check_timeout_sec,
          health_check_retries, health_cmd, cpu_limit, memory_limit_mb, memory_swap_mb, pids_limit,
          cap_drop_all, no_new_privileges, restart_policy, position,
          repo_installation_id, repo_full_name, repo_branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.healthCheckIntervalSec ?? DEFAULT_HEALTH_CHECK.intervalSec,
      input.healthCheckTimeoutSec ?? DEFAULT_HEALTH_CHECK.timeoutSec,
      input.healthCheckRetries ?? DEFAULT_HEALTH_CHECK.retries,
      input.healthCmd ?? null,
      input.cpuLimit ?? null,
      input.memoryLimitMb ?? null,
      input.memorySwapMb ?? null,
      input.pidsLimit ?? null,
      input.capDropAll ? 1 : 0,
      input.noNewPrivileges ? 1 : 0,
      input.restartPolicy ?? "unless-stopped",
      nextPos,
      repoInstallationRowId,
      input.gitSource?.repoFullName ?? null,
      input.gitSource?.branch ?? null,
      now,
      now,
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      throw new AppError("COMPONENT_DUPLICATE_NAME", {
        th: `ชื่อ component "${input.name}" ถูกใช้แล้วในโปรเจกต์นี้`,
        en: `Component name "${input.name}" is already used in this project`,
      });
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
  healthCheckIntervalSec?: number;
  healthCheckTimeoutSec?: number;
  healthCheckRetries?: number;
  healthCmd?: string | null;
  cpuLimit?: number | null;
  memoryLimitMb?: number | null;
  memorySwapMb?: number | null;
  pidsLimit?: number | null;
  capDropAll?: boolean;
  noNewPrivileges?: boolean;
  restartPolicy?: string;
  enabled?: boolean;
  dockerfilePath?: string | null;
  buildContext?: string | null;
  targetStage?: string | null;
  /** undefined = ไม่แตะ · null = กลับไปใช้ repo ของ project */
  gitSource?: ComponentGitSource | null;
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
    gitSource: update.gitSource !== undefined ? update.gitSource : null,
    imageRef: update.imageRef ?? row.image_ref,
    managedServiceId: row.managed_service_id,
    command: update.command ?? row.command,
    internalPort: update.internalPort ?? row.internal_port,
    isWeb: update.isWeb ?? row.is_web === 1,
    webPort: update.webPort ?? row.web_port,
    healthCheckPath: update.healthCheckPath ?? row.health_check_path,
    healthCheckIntervalSec: update.healthCheckIntervalSec ?? row.health_check_interval_sec,
    healthCheckTimeoutSec: update.healthCheckTimeoutSec ?? row.health_check_timeout_sec,
    healthCheckRetries: update.healthCheckRetries ?? row.health_check_retries,
    healthCmd: update.healthCmd ?? row.health_cmd,
    cpuLimit: update.cpuLimit ?? row.cpu_limit,
    memoryLimitMb: update.memoryLimitMb ?? row.memory_limit_mb,
    memorySwapMb: update.memorySwapMb !== undefined ? update.memorySwapMb : row.memory_swap_mb,
    pidsLimit: update.pidsLimit !== undefined ? update.pidsLimit : row.pids_limit,
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
  if (update.healthCheckIntervalSec !== undefined)
    set("health_check_interval_sec", update.healthCheckIntervalSec);
  if (update.healthCheckTimeoutSec !== undefined)
    set("health_check_timeout_sec", update.healthCheckTimeoutSec);
  if (update.healthCheckRetries !== undefined)
    set("health_check_retries", update.healthCheckRetries);
  if (update.healthCmd !== undefined) set("health_cmd", update.healthCmd);
  if (update.cpuLimit !== undefined) set("cpu_limit", update.cpuLimit);
  if (update.memoryLimitMb !== undefined) set("memory_limit_mb", update.memoryLimitMb);
  if (update.memorySwapMb !== undefined) set("memory_swap_mb", update.memorySwapMb);
  if (update.pidsLimit !== undefined) set("pids_limit", update.pidsLimit);
  if (update.capDropAll !== undefined) set("cap_drop_all", update.capDropAll ? 1 : 0);
  if (update.noNewPrivileges !== undefined)
    set("no_new_privileges", update.noNewPrivileges ? 1 : 0);
  if (update.restartPolicy !== undefined) set("restart_policy", update.restartPolicy);
  if (update.enabled !== undefined) set("enabled", update.enabled ? 1 : 0);
  if (update.dockerfilePath !== undefined) set("dockerfile_path", update.dockerfilePath);
  if (update.buildContext !== undefined) set("build_context", update.buildContext);
  if (update.targetStage !== undefined) set("target_stage", update.targetStage);
  if (update.imageRef !== undefined) set("image_ref", update.imageRef);
  if (update.gitSource !== undefined) {
    set(
      "repo_installation_id",
      update.gitSource ? resolveInstallationRowId(db, update.gitSource.installationId) : null,
    );
    set("repo_full_name", update.gitSource?.repoFullName ?? null);
    set("repo_branch", update.gitSource?.branch ?? null);
  }

  if (fields.length > 0) {
    set("updated_at", Date.now());
    values.push(componentId);
    try {
      db.query(`UPDATE project_components SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE")) {
        throw new AppError("COMPONENT_DUPLICATE_NAME", {
          th: "ชื่อ component นี้ถูกใช้แล้วในโปรเจกต์นี้",
          en: "This component name is already used in this project",
        });
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
  db.transaction(() => {
    // domain ที่ผูกไว้กลับไปใช้ web ตัวแรก (FK ไม่มี ON DELETE — ไม่ปลดก่อนจะลบ component ไม่ได้)
    db.query(
      "UPDATE project_domains SET component_id = NULL, updated_at = ? WHERE component_id = ?",
    ).run(Date.now(), componentId);
    // volume ที่ mount อยู่ → detached (ข้อมูลยังอยู่ ลบหรือสร้างใหม่ให้ component อื่นได้ที่แท็บ Volumes)
    db.query(
      `UPDATE volumes
       SET component_id = NULL, updated_at = ?,
           lifecycle = CASE WHEN lifecycle = 'active' THEN 'detached' ELSE lifecycle END
       WHERE component_id = ?`,
    ).run(Date.now(), componentId);
    // env ที่ตั้งเฉพาะ component นี้ไม่มีความหมายเมื่อไม่มี component แล้ว
    db.query("DELETE FROM environment_variables WHERE component_id = ?").run(componentId);
    // component_deps ที่ชี้มา/ชี้ออกถูกลบด้วย ON DELETE CASCADE ของ FK
    db.query("DELETE FROM project_components WHERE id = ? AND project_id = ?").run(
      componentId,
      projectId,
    );
  })();
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
    throw new AppError("COMPOSE_PROMOTE_INVALID", {
      th: "ต้องมี component อย่างน้อยหนึ่งตัวก่อนเปิดโหมด compose",
      en: "At least one component is required before enabling compose mode",
    });
  }
  if (!components.some((c) => c.isWeb)) {
    throw new AppError("COMPOSE_PROMOTE_INVALID", {
      th: "ต้องมี component ที่เป็น web อย่างน้อยหนึ่งตัว (ตัวที่รับ traffic จากภายนอก)",
      en: "At least one web component is required (the one that receives external traffic)",
    });
  }
  db.query("UPDATE projects SET mode = 'compose', updated_at = ? WHERE id = ?").run(
    Date.now(),
    projectId,
  );
}
