import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, isUlid, ulid } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import { getClientIp, recordAuditEvent } from "../audit/log";
import { authPlugin, requireAuthenticated } from "../plugins/auth";

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  mode: string;
  source_type: string;
  installation_id: string | null;
  repo_id: number | null;
  repo_full_name: string | null;
  branch: string | null;
  auto_deploy: number;
  dockerfile_path: string;
  build_context: string;
  internal_port: number | null;
  exposed_port: number | null;
  health_check_path: string | null;
  archived_at: number | null;
  degraded_at: number | null;
  created_at: number;
  updated_at: number;
  /**
   * Phase 11 — สถานะ deployment ที่ยังไม่จบ (มาจาก subquery ไม่ใช่ column ใน projects)
   *
   * ต้องแยกจาก projects.status เพราะสองอย่างนี้ตอบคนละคำถาม:
   *   projects.status     = "แอปให้บริการอยู่ไหม" (running/stopped)
   *   deployments.status  = "การ build ครั้งนี้ไปถึงไหน" (building/starting/...)
   * build ที่ล้มเหลวไม่ทำให้แอปล่ม (ADR-0004) — projects.status จึงต้องไม่กลายเป็น failed
   * ตามไปด้วย ไม่งั้น dashboard จะบอกว่าแอปตายทั้งที่ยังให้บริการปกติ
   */
  active_deployment_status: string | null;
  active_deployment_sha: string | null;
  /** สถานะ deployment ล่าสุดที่จบแล้ว — ใช้ชี้ว่า "deploy ครั้งล่าสุดพัง" โดยไม่แตะ project status */
  last_deployment_status: string | null;
  /** เวลาแก้ env ล่าสุด (MAX จาก subquery — ทุก scope รวม component และ disabled) — null = ไม่มี env */
  env_updated_at: number | null;
}

const projectSchema = t.Object({
  id: t.String(),
  name: t.String(),
  status: t.Union([
    t.Literal("new"),
    t.Literal("running"),
    t.Literal("deploying"),
    t.Literal("failed"),
    t.Literal("stopped"),
  ]),
  // Phase 18 — 'single' (pipeline เดิม, 1 container) หรือ 'compose' (multi-container orchestrator)
  mode: t.Union([t.Literal("single"), t.Literal("compose")]),
  // Phase 8 M2 — active container หายไปจาก Docker ทั้งที่ status ยังเป็น 'running'
  degraded: t.Boolean(),
  // Phase 13 — 'github' (default, เชื่อม repo) หรือ 'dockerfile' (วางเนื้อหาเอง ไม่มี repo)
  sourceType: t.Union([t.Literal("github"), t.Literal("dockerfile")]),
  installationId: t.Nullable(t.String()),
  repoId: t.Nullable(t.Number()),
  repoFullName: t.Nullable(t.String()),
  branch: t.Nullable(t.String()),
  autoDeploy: t.Boolean(),
  dockerfilePath: t.String(),
  buildContext: t.String(),
  internalPort: t.Nullable(t.Number()),
  /** host port ที่ map เข้า internal port ตรง ๆ (เช่น host 3100 → container 3000) — null = ไม่ expose */
  exposedPort: t.Nullable(t.Number()),
  healthCheckPath: t.Nullable(t.String()),
  archivedAt: t.Nullable(t.Number()),
  createdAt: t.Number(),
  updatedAt: t.Number(),
  /** deployment ที่ยังไม่จบ — null = ไม่มีงานค้าง (ดู comment ที่ ProjectRow) */
  activeDeployment: t.Nullable(t.Object({ status: t.String(), commitSha: t.String() })),
  lastDeploymentStatus: t.Nullable(t.String()),
  /**
   * เวลาแก้ environment variables ครั้งล่าสุด (ทุก scope รวม component และตัวที่ disabled —
   * การแก้ใดๆ ก็ทำให้ค่าที่ deploy ไว้ล้าสมัยได้) — null = ยังไม่มี env เลย
   * dashboard ใช้เทียบกับเวลา deploy ล่าสุด เพื่อเตือนว่า "แก้ env แล้วแต่ยังไม่ได้กด Deploy"
   */
  envUpdatedAt: t.Nullable(t.Number()),
});

const createBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 100 }),
});

const updateBody = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  dockerfilePath: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
  buildContext: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
  internalPort: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 65535 }))),
  exposedPort: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 65535 }))),
  healthCheckPath: t.Optional(t.Nullable(t.String({ maxLength: 255 }))),
  autoDeploy: t.Optional(t.Boolean()),
});

function toProject(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    status: row.status as "new" | "running" | "deploying" | "failed" | "stopped",
    mode: row.mode === "compose" ? ("compose" as const) : ("single" as const),
    degraded: row.degraded_at != null,
    sourceType: row.source_type as "github" | "dockerfile",
    installationId: row.installation_id,
    repoId: row.repo_id,
    repoFullName: row.repo_full_name,
    branch: row.branch,
    autoDeploy: row.auto_deploy === 1,
    dockerfilePath: row.dockerfile_path,
    buildContext: row.build_context,
    internalPort: row.internal_port,
    exposedPort: row.exposed_port,
    healthCheckPath: row.health_check_path,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activeDeployment: row.active_deployment_status
      ? { status: row.active_deployment_status, commitSha: row.active_deployment_sha ?? "" }
      : null,
    lastDeploymentStatus: row.last_deployment_status,
    envUpdatedAt: row.env_updated_at,
  };
}

/**
 * subquery lookup ต่อ project — deployments มี partial index รองรับตั้งแต่ migration 0006
 * (idx_deployments_in_flight, idx_deployments_project_created) ส่วน env ใช้ idx_env_vars_project
 * จึงไม่ scan ตาราง · ใช้ p. prefix เพราะ query หลักต้อง alias projects เป็น p
 */
const SELECT_COLUMNS = `p.id, p.name, p.status, p.mode, p.source_type, p.installation_id, p.repo_id, p.repo_full_name,
  p.branch, p.auto_deploy, p.dockerfile_path, p.build_context, p.internal_port, p.exposed_port,
  p.health_check_path, p.archived_at, p.degraded_at, p.created_at, p.updated_at,
  (SELECT d.status FROM deployments d
    WHERE d.project_id = p.id AND d.status NOT IN ('succeeded','failed','cancelled')
    ORDER BY d.created_at DESC LIMIT 1) AS active_deployment_status,
  (SELECT substr(d.commit_sha, 1, 7) FROM deployments d
    WHERE d.project_id = p.id AND d.status NOT IN ('succeeded','failed','cancelled')
    ORDER BY d.created_at DESC LIMIT 1) AS active_deployment_sha,
  (SELECT d.status FROM deployments d
    WHERE d.project_id = p.id AND d.status IN ('succeeded','failed','cancelled')
    ORDER BY d.created_at DESC LIMIT 1) AS last_deployment_status,
  (SELECT MAX(e.updated_at) FROM environment_variables e
    WHERE e.project_id = p.id) AS env_updated_at`;

function loadProject(db: Database, id: string): ProjectRow {
  // ตรวจรูปแบบ ID ก่อนแตะ DB — public ID เป็น ULID เสมอ (ADR-0005)
  if (!isUlid(id)) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
  const row = db
    .query<ProjectRow, [string]>(`SELECT ${SELECT_COLUMNS} FROM projects p WHERE p.id = ?`)
    .get(id);
  if (!row) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
  return row;
}

/**
 * exposed port ห้ามชนกับ project อื่น (unique index กันอยู่แล้วแต่ error message ห่วย),
 * managed service (คนละตาราง — constraint ข้ามตารางทำไม่ได้), และ port ที่ระบบใช้เอง
 */
const RESERVED_PORTS = new Set([80, 443, 3000, 3001]);

function assertExposedPortAvailable(db: Database, port: number, projectId: string): void {
  if (RESERVED_PORTS.has(port)) {
    throw new AppError("VALIDATION_ERROR", `port ${port} ถูกใช้โดยระบบ Zixploy เอง — เลือก port อื่น`, {
      field: "exposedPort",
    });
  }
  const projectHit = db
    .query<{ name: string }, [number, string]>(
      "SELECT name FROM projects WHERE exposed_port = ? AND id != ? AND archived_at IS NULL",
    )
    .get(port, projectId);
  if (projectHit) {
    throw new AppError(
      "VALIDATION_ERROR",
      `port ${port} ถูกใช้โดย project "${projectHit.name}" อยู่แล้ว`,
      { field: "exposedPort" },
    );
  }
  const serviceHit = db
    .query<{ name: string }, [number]>("SELECT name FROM services WHERE exposed_port = ?")
    .get(port);
  if (serviceHit) {
    throw new AppError(
      "VALIDATION_ERROR",
      `port ${port} ถูกใช้โดย database "${serviceHit.name}" อยู่แล้ว`,
      { field: "exposedPort" },
    );
  }
}

/** path ต้องเป็น relative และห้ามออกนอก build context (กัน path traversal ตั้งแต่ชั้น API) */
function assertSafeRelativePath(value: string, field: string): void {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new AppError("VALIDATION_ERROR", `${field} ต้องเป็น relative path`, { field });
  }
  if (normalized.split("/").includes("..")) {
    throw new AppError("VALIDATION_ERROR", `${field} ต้องไม่มี ".."`, { field });
  }
}

export function projectRoutes(db: Database) {
  return new Elysia({ prefix: `${API_PREFIX}/projects` })
    .use(authPlugin(db))
    .guard({ beforeHandle: requireAuthenticated })
    .get(
      "/",
      ({ query }) => {
        const includeArchived = query.includeArchived === "true";
        const rows = db
          .query<ProjectRow, []>(
            `SELECT ${SELECT_COLUMNS} FROM projects p
             ${includeArchived ? "" : "WHERE p.archived_at IS NULL"}
             ORDER BY p.id DESC`,
          )
          .all();
        return { items: rows.map(toProject) };
      },
      {
        query: t.Object({ includeArchived: t.Optional(t.String()) }),
        response: t.Object({ items: t.Array(projectSchema) }),
      },
    )
    .post(
      "/",
      ({ body, set }) => {
        const now = Date.now();
        const id = ulid();
        db.query(
          `INSERT INTO projects (id, name, status, created_at, updated_at)
           VALUES (?, ?, 'new', ?, ?)`,
        ).run(id, body.name.trim(), now, now);
        set.status = 201;
        return toProject(loadProject(db, id));
      },
      { body: createBody, response: projectSchema },
    )
    .get("/:id", ({ params }) => toProject(loadProject(db, params.id)), {
      response: projectSchema,
    })
    .patch(
      "/:id",
      ({ params, body, request, requireSession }) => {
        const session = requireSession();
        const existing = loadProject(db, params.id);
        if (existing.archived_at !== null) {
          throw new AppError("PROJECT_ARCHIVED", "project นี้ถูก archive แล้ว แก้ไขไม่ได้");
        }
        if (body.dockerfilePath !== undefined) {
          assertSafeRelativePath(body.dockerfilePath, "dockerfilePath");
        }
        if (body.buildContext !== undefined) {
          assertSafeRelativePath(body.buildContext, "buildContext");
        }
        if (body.exposedPort != null) {
          assertExposedPortAvailable(db, body.exposedPort, params.id);
        }

        const fields: string[] = [];
        const values: (string | number | null)[] = [];
        const set = (column: string, value: string | number | null) => {
          fields.push(`${column} = ?`);
          values.push(value);
        };

        if (body.name !== undefined) set("name", body.name.trim());
        if (body.dockerfilePath !== undefined) set("dockerfile_path", body.dockerfilePath);
        if (body.buildContext !== undefined) set("build_context", body.buildContext);
        if (body.internalPort !== undefined) set("internal_port", body.internalPort);
        if (body.exposedPort !== undefined) set("exposed_port", body.exposedPort);
        if (body.healthCheckPath !== undefined) set("health_check_path", body.healthCheckPath);
        if (body.autoDeploy !== undefined) set("auto_deploy", body.autoDeploy ? 1 : 0);

        if (fields.length > 0) {
          set("updated_at", Date.now());
          values.push(params.id);
          db.query(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(...values);
          recordAuditEvent(db, {
            actorUserId: session.userId,
            action: "project_updated",
            resourceType: "project",
            resourceId: params.id,
            metadata: { fields: Object.keys(body) },
            ip: getClientIp(request),
          });
        }

        return toProject(loadProject(db, params.id));
      },
      { body: updateBody, response: projectSchema },
    )
    .post(
      "/:id/archive",
      ({ params, request, requireSession }) => {
        const session = requireSession();
        const existing = loadProject(db, params.id);
        // idempotent: archive ซ้ำไม่เปลี่ยนเวลาเดิม
        if (existing.archived_at === null) {
          const now = Date.now();
          db.query("UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?").run(
            now,
            now,
            params.id,
          );
          recordAuditEvent(db, {
            actorUserId: session.userId,
            action: "project_archived",
            resourceType: "project",
            resourceId: params.id,
            ip: getClientIp(request),
          });
        }
        return toProject(loadProject(db, params.id));
      },
      { response: projectSchema },
    );
}
