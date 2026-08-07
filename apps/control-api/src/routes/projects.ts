import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, isUlid, ulid } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import { getClientIp, recordAuditEvent } from "../audit/log";
import { authPlugin, requireAuthenticated } from "../plugins/auth";

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  installation_id: string | null;
  repo_id: number | null;
  repo_full_name: string | null;
  branch: string | null;
  auto_deploy: number;
  dockerfile_path: string;
  build_context: string;
  internal_port: number | null;
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
  // Phase 8 M2 — active container หายไปจาก Docker ทั้งที่ status ยังเป็น 'running'
  degraded: t.Boolean(),
  installationId: t.Nullable(t.String()),
  repoId: t.Nullable(t.Number()),
  repoFullName: t.Nullable(t.String()),
  branch: t.Nullable(t.String()),
  autoDeploy: t.Boolean(),
  dockerfilePath: t.String(),
  buildContext: t.String(),
  internalPort: t.Nullable(t.Number()),
  healthCheckPath: t.Nullable(t.String()),
  archivedAt: t.Nullable(t.Number()),
  createdAt: t.Number(),
  updatedAt: t.Number(),
  /** deployment ที่ยังไม่จบ — null = ไม่มีงานค้าง (ดู comment ที่ ProjectRow) */
  activeDeployment: t.Nullable(t.Object({ status: t.String(), commitSha: t.String() })),
  lastDeploymentStatus: t.Nullable(t.String()),
});

const createBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 100 }),
});

const updateBody = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  dockerfilePath: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
  buildContext: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
  internalPort: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 65535 }))),
  healthCheckPath: t.Optional(t.Nullable(t.String({ maxLength: 255 }))),
  autoDeploy: t.Optional(t.Boolean()),
});

function toProject(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    status: row.status as "new" | "running" | "deploying" | "failed" | "stopped",
    degraded: row.degraded_at != null,
    installationId: row.installation_id,
    repoId: row.repo_id,
    repoFullName: row.repo_full_name,
    branch: row.branch,
    autoDeploy: row.auto_deploy === 1,
    dockerfilePath: row.dockerfile_path,
    buildContext: row.build_context,
    internalPort: row.internal_port,
    healthCheckPath: row.health_check_path,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activeDeployment: row.active_deployment_status
      ? { status: row.active_deployment_status, commitSha: row.active_deployment_sha ?? "" }
      : null,
    lastDeploymentStatus: row.last_deployment_status,
  };
}

/**
 * subquery สอง lookup ต่อ project — ทั้งคู่มี partial index รองรับตั้งแต่ migration 0006
 * (idx_deployments_in_flight, idx_deployments_project_created) จึงไม่ scan ตาราง
 * ใช้ p. prefix เพราะ query หลักต้อง alias projects เป็น p
 */
const SELECT_COLUMNS = `p.id, p.name, p.status, p.installation_id, p.repo_id, p.repo_full_name,
  p.branch, p.auto_deploy, p.dockerfile_path, p.build_context, p.internal_port,
  p.health_check_path, p.archived_at, p.degraded_at, p.created_at, p.updated_at,
  (SELECT d.status FROM deployments d
    WHERE d.project_id = p.id AND d.status NOT IN ('succeeded','failed','cancelled')
    ORDER BY d.created_at DESC LIMIT 1) AS active_deployment_status,
  (SELECT substr(d.commit_sha, 1, 7) FROM deployments d
    WHERE d.project_id = p.id AND d.status NOT IN ('succeeded','failed','cancelled')
    ORDER BY d.created_at DESC LIMIT 1) AS active_deployment_sha,
  (SELECT d.status FROM deployments d
    WHERE d.project_id = p.id AND d.status IN ('succeeded','failed','cancelled')
    ORDER BY d.created_at DESC LIMIT 1) AS last_deployment_status`;

function loadProject(db: Database, id: string): ProjectRow {
  // ตรวจรูปแบบ ID ก่อนแตะ DB — public ID เป็น ULID เสมอ (ADR-0005)
  if (!isUlid(id)) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
  const row = db
    .query<ProjectRow, [string]>(`SELECT ${SELECT_COLUMNS} FROM projects p WHERE p.id = ?`)
    .get(id);
  if (!row) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
  return row;
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
