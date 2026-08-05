import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, isUlid, ulid } from "@zixploy/shared";
import { Elysia, t } from "elysia";
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
  created_at: number;
  updated_at: number;
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
  };
}

const SELECT_COLUMNS = `id, name, status, installation_id, repo_id, repo_full_name, branch, auto_deploy,
  dockerfile_path, build_context, internal_port, health_check_path, archived_at, created_at, updated_at`;

function loadProject(db: Database, id: string): ProjectRow {
  // ตรวจรูปแบบ ID ก่อนแตะ DB — public ID เป็น ULID เสมอ (ADR-0005)
  if (!isUlid(id)) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
  const row = db
    .query<ProjectRow, [string]>(`SELECT ${SELECT_COLUMNS} FROM projects WHERE id = ?`)
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
            `SELECT ${SELECT_COLUMNS} FROM projects
             ${includeArchived ? "" : "WHERE archived_at IS NULL"}
             ORDER BY id DESC`,
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
      ({ params, body }) => {
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
        }

        return toProject(loadProject(db, params.id));
      },
      { body: updateBody, response: projectSchema },
    )
    .post(
      "/:id/archive",
      ({ params }) => {
        const existing = loadProject(db, params.id);
        // idempotent: archive ซ้ำไม่เปลี่ยนเวลาเดิม
        if (existing.archived_at === null) {
          const now = Date.now();
          db.query("UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?").run(
            now,
            now,
            params.id,
          );
        }
        return toProject(loadProject(db, params.id));
      },
      { response: projectSchema },
    );
}
