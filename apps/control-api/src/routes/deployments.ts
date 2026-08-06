/**
 * Deploy Operations API (Phase 3) — trigger/observe deployments
 *
 * POST   /api/v1/projects/:id/deploy         — deploy commit ล่าสุดของ branch ที่ตั้งไว้
 * POST   /api/v1/projects/:id/redeploy        — deploy ซ้ำ commit ของ deployment ล่าสุด
 * POST   /api/v1/projects/:id/restart         — restart container ที่ active อยู่
 * POST   /api/v1/projects/:id/stop            — stop container ที่ active อยู่
 * POST   /api/v1/projects/:id/rollback        — สร้าง deployment ใหม่อ้าง image เดิมของ deployment ก่อนหน้า
 * POST   /api/v1/deployments/:id/cancel       — ยกเลิก deployment (idempotent)
 * GET    /api/v1/projects/:id/deployments     — ประวัติ deployment ของ project (keyset pagination)
 * GET    /api/v1/deployments/:id              — deployment เดียว
 *
 * control-api เป็นฝ่ายเดียวที่ INSERT ลง deploy_jobs (ADR-0002) — ดู ../deploys/queue.ts
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, type DeploymentStatus, isUlid } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import {
  cancelDeployment,
  type DeployJobPayload,
  enqueueManualJob,
  enqueueOperation,
} from "../deploys/queue";
import type { GitHubAppRegistry } from "../github/registry";
import { authPlugin, requireAuthenticated } from "../plugins/auth";

interface DeploymentRow {
  id: string;
  project_id: string;
  status: string;
  trigger: string;
  commit_sha: string;
  commit_message: string | null;
  commit_author: string | null;
  image_tag: string | null;
  image_digest: string | null;
  container_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  queued_at: number;
  started_at: number | null;
  finished_at: number | null;
  cloning_at: number | null;
  building_at: number | null;
  starting_at: number | null;
  health_checking_at: number | null;
  activating_at: number | null;
  created_at: number;
  updated_at: number;
}

const SELECT_COLUMNS = `id, project_id, status, trigger, commit_sha, commit_message, commit_author,
  image_tag, image_digest, container_id, failure_code, failure_message,
  queued_at, started_at, finished_at, cloning_at, building_at, starting_at, health_checking_at, activating_at,
  created_at, updated_at`;

const deploymentSchema = t.Object({
  id: t.String(),
  projectId: t.String(),
  status: t.Union([
    t.Literal("queued"),
    t.Literal("cloning"),
    t.Literal("building"),
    t.Literal("starting"),
    t.Literal("health_checking"),
    t.Literal("activating"),
    t.Literal("succeeded"),
    t.Literal("failed"),
    t.Literal("cancelled"),
  ]),
  trigger: t.Union([
    t.Literal("push"),
    t.Literal("manual"),
    t.Literal("redeploy"),
    t.Literal("rollback"),
  ]),
  commitSha: t.String(),
  commitMessage: t.Nullable(t.String()),
  commitAuthor: t.Nullable(t.String()),
  imageTag: t.Nullable(t.String()),
  imageDigest: t.Nullable(t.String()),
  containerId: t.Nullable(t.String()),
  failureCode: t.Nullable(t.String()),
  failureMessage: t.Nullable(t.String()),
  queuedAt: t.Number(),
  startedAt: t.Nullable(t.Number()),
  finishedAt: t.Nullable(t.Number()),
  cloningAt: t.Nullable(t.Number()),
  buildingAt: t.Nullable(t.Number()),
  startingAt: t.Nullable(t.Number()),
  healthCheckingAt: t.Nullable(t.Number()),
  activatingAt: t.Nullable(t.Number()),
  createdAt: t.Number(),
  updatedAt: t.Number(),
});

function toDeployment(row: DeploymentRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status as DeploymentStatus,
    trigger: row.trigger as "push" | "manual" | "redeploy" | "rollback",
    commitSha: row.commit_sha,
    commitMessage: row.commit_message,
    commitAuthor: row.commit_author,
    imageTag: row.image_tag,
    imageDigest: row.image_digest,
    containerId: row.container_id,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    cloningAt: row.cloning_at,
    buildingAt: row.building_at,
    startingAt: row.starting_at,
    healthCheckingAt: row.health_checking_at,
    activatingAt: row.activating_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function loadDeployment(db: Database, id: string): DeploymentRow {
  if (!isUlid(id)) throw new AppError("DEPLOYMENT_NOT_FOUND", "ไม่พบ deployment นี้");
  const row = db
    .query<DeploymentRow, [string]>(`SELECT ${SELECT_COLUMNS} FROM deployments WHERE id = ?`)
    .get(id);
  if (!row) throw new AppError("DEPLOYMENT_NOT_FOUND", "ไม่พบ deployment นี้");
  return row;
}

interface ProjectSourceRow {
  id: string;
  archived_at: number | null;
  installation_id: string | null;
  repo_id: number | null;
  repo_full_name: string | null;
  branch: string | null;
}

function loadProjectForDeploy(db: Database, id: string): ProjectSourceRow {
  if (!isUlid(id)) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
  const row = db
    .query<ProjectSourceRow, [string]>(
      "SELECT id, archived_at, installation_id, repo_id, repo_full_name, branch FROM projects WHERE id = ?",
    )
    .get(id);
  if (!row) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
  if (row.archived_at !== null) {
    throw new AppError("PROJECT_ARCHIVED", "project นี้ถูก archive แล้ว");
  }
  return row;
}

/** ต้องเชื่อมต่อ repository/branch ก่อนถึง deploy ได้ */
function assertProjectHasSource(project: ProjectSourceRow): asserts project is ProjectSourceRow & {
  installation_id: string;
  repo_full_name: string;
  branch: string;
} {
  if (!project.installation_id || !project.repo_full_name || !project.branch) {
    throw new AppError(
      "VALIDATION_ERROR",
      "project นี้ยังไม่ได้เชื่อมต่อ repository — ตั้งค่าที่ Source tab ก่อน",
      {
        field: "source",
      },
    );
  }
}

interface InstallationLookup {
  installationId: number;
  status: string;
}

/** installation_id ที่ project เก็บคือ internal ULID row — ต้อง lookup numeric GitHub installation_id */
function loadInstallationForProject(db: Database, installationRowId: string): InstallationLookup {
  const row = db
    .query<{ installation_id: number; status: string }, [string]>(
      "SELECT installation_id, status FROM github_installations WHERE id = ?",
    )
    .get(installationRowId);
  if (!row) throw new AppError("INSTALLATION_NOT_FOUND", "ไม่พบ GitHub installation ของ project นี้");
  if (row.status !== "active") {
    throw new AppError(
      "GITHUB_UNAVAILABLE",
      "GitHub installation ไม่ได้ active — reinstall หรือ unsuspend ก่อน deploy",
    );
  }
  return { installationId: row.installation_id, status: row.status };
}

interface CursorPage {
  createdAt: number;
  id: string;
}

function encodeCursor(row: CursorPage): string {
  return Buffer.from(JSON.stringify(row)).toString("base64url");
}

function decodeCursor(value: string): CursorPage | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.createdAt === "number" &&
      typeof parsed.id === "string"
    ) {
      return parsed as CursorPage;
    }
    return null;
  } catch {
    return null;
  }
}

export function deploymentRoutes(db: Database, registry: GitHubAppRegistry) {
  // === Project-scoped operations ===
  const projectApp = new Elysia({ prefix: `${API_PREFIX}/projects` })
    .use(authPlugin(db))
    .guard({ beforeHandle: requireAuthenticated })

    .post(
      "/:id/deploy",
      async ({ params, set }) => {
        const project = loadProjectForDeploy(db, params.id);
        assertProjectHasSource(project);
        const { installationId } = loadInstallationForProject(db, project.installation_id);

        const service = await registry.getServiceForInstallation(installationId);
        if (!service) {
          throw new AppError("GITHUB_UNAVAILABLE", "GitHub App ของ installation นี้ไม่พร้อมใช้งาน");
        }
        const branch = await service.validateBranch(
          installationId,
          project.repo_full_name,
          project.branch,
        );

        const payload: DeployJobPayload = {
          kind: "build",
          trigger: "manual",
          commitSha: branch.commitSha,
          commitMessage: null,
          commitAuthor: null,
          installationId,
          repoFullName: project.repo_full_name,
        };
        const { deploymentId } = enqueueManualJob(db, {
          projectId: params.id,
          trigger: "manual",
          commitSha: branch.commitSha,
          commitMessage: null,
          commitAuthor: null,
          payload,
        });

        set.status = 201;
        return toDeployment(loadDeployment(db, deploymentId));
      },
      { response: deploymentSchema },
    )

    .post(
      "/:id/redeploy",
      ({ params, set }) => {
        const project = loadProjectForDeploy(db, params.id);
        assertProjectHasSource(project);
        const { installationId } = loadInstallationForProject(db, project.installation_id);

        const last = db
          .query<
            { commit_sha: string; commit_message: string | null; commit_author: string | null },
            [string]
          >(
            "SELECT commit_sha, commit_message, commit_author FROM deployments WHERE project_id = ? ORDER BY created_at DESC LIMIT 1",
          )
          .get(params.id);
        if (!last) {
          throw new AppError("VALIDATION_ERROR", "ยังไม่เคย deploy project นี้มาก่อน — ใช้ deploy แทน");
        }

        const payload: DeployJobPayload = {
          kind: "build",
          trigger: "redeploy",
          commitSha: last.commit_sha,
          commitMessage: last.commit_message,
          commitAuthor: last.commit_author,
          installationId,
          repoFullName: project.repo_full_name,
        };
        const { deploymentId } = enqueueManualJob(db, {
          projectId: params.id,
          trigger: "redeploy",
          commitSha: last.commit_sha,
          commitMessage: last.commit_message,
          commitAuthor: last.commit_author,
          payload,
        });

        set.status = 201;
        return toDeployment(loadDeployment(db, deploymentId));
      },
      { response: deploymentSchema },
    )

    .post(
      "/:id/restart",
      ({ params }) => {
        loadProjectForDeploy(db, params.id);
        const { jobId } = enqueueOperation(db, params.id, "restart");
        return { jobId };
      },
      { response: t.Object({ jobId: t.String() }) },
    )

    .post(
      "/:id/stop",
      ({ params }) => {
        loadProjectForDeploy(db, params.id);
        const { jobId } = enqueueOperation(db, params.id, "stop");
        return { jobId };
      },
      { response: t.Object({ jobId: t.String() }) },
    )

    .post(
      "/:id/rollback",
      ({ params, body, set }) => {
        loadProjectForDeploy(db, params.id);
        const target = db
          .query<DeploymentRow, [string, string]>(
            `SELECT ${SELECT_COLUMNS} FROM deployments WHERE id = ? AND project_id = ?`,
          )
          .get(body.targetDeploymentId, params.id);

        if (!target || target.status !== "succeeded" || !target.image_tag || !target.image_digest) {
          throw new AppError(
            "ROLLBACK_TARGET_UNAVAILABLE",
            "deployment เป้าหมายไม่พร้อมสำหรับ rollback — ต้องเป็น deployment ที่ succeeded และมี image อยู่",
          );
        }

        const payload: DeployJobPayload = {
          kind: "rollback",
          targetDeploymentId: target.id,
          imageTag: target.image_tag,
          imageDigest: target.image_digest,
        };
        const { deploymentId } = enqueueManualJob(db, {
          projectId: params.id,
          trigger: "rollback",
          commitSha: target.commit_sha,
          commitMessage: target.commit_message,
          commitAuthor: target.commit_author,
          payload,
        });

        set.status = 201;
        return toDeployment(loadDeployment(db, deploymentId));
      },
      {
        body: t.Object({ targetDeploymentId: t.String() }),
        response: deploymentSchema,
      },
    )

    .get(
      "/:id/deployments",
      ({ params, query }) => {
        loadProjectForDeploy(db, params.id);

        const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)));
        const cursor = query.cursor ? decodeCursor(query.cursor) : null;

        const rows = cursor
          ? db
              .query<DeploymentRow, [string, number, number, string, number]>(
                `SELECT ${SELECT_COLUMNS} FROM deployments
                 WHERE project_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
                 ORDER BY created_at DESC, id DESC LIMIT ?`,
              )
              .all(params.id, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1)
          : db
              .query<DeploymentRow, [string, number]>(
                `SELECT ${SELECT_COLUMNS} FROM deployments
                 WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
              )
              .all(params.id, limit + 1);

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const last = page[page.length - 1];
        const nextCursor =
          hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : undefined;

        return { items: page.map(toDeployment), ...(nextCursor ? { nextCursor } : {}) };
      },
      {
        query: t.Object({
          limit: t.Optional(t.String()),
          cursor: t.Optional(t.String()),
        }),
        response: t.Object({
          items: t.Array(deploymentSchema),
          nextCursor: t.Optional(t.String()),
        }),
      },
    );

  // === Deployment-scoped operations ===
  const deploymentApp = new Elysia({ prefix: `${API_PREFIX}/deployments` })
    .use(authPlugin(db))
    .guard({ beforeHandle: requireAuthenticated })

    .get("/:id", ({ params }) => toDeployment(loadDeployment(db, params.id)), {
      response: deploymentSchema,
    })

    .post(
      "/:id/cancel",
      ({ params }) => {
        loadDeployment(db, params.id); // throws DEPLOYMENT_NOT_FOUND ถ้าไม่มี
        cancelDeployment(db, params.id);
        return toDeployment(loadDeployment(db, params.id));
      },
      { response: deploymentSchema },
    );

  return new Elysia().use(projectApp).use(deploymentApp);
}
