/**
 * GitHub App integration routes
 *
 * GET  /api/v1/github/status                          — public, configuration status
 * GET  /api/v1/github/install-url                     — auth, URL เพื่อ install GitHub App
 * GET  /api/v1/github/callback                        — auth (session cookie), post-install callback
 * GET  /api/v1/github/installations                   — auth, list stored installations
 * GET  /api/v1/github/installations/:id/repositories  — auth, live from GitHub API
 * GET  /api/v1/github/branches                        — auth, query: installationId, repo
 * POST /api/v1/projects/:id/source                    — auth + CSRF, connect repository
 * DELETE /api/v1/projects/:id/source                  — auth + CSRF, disconnect repository
 *
 * ห้าม endpoint ใดส่ง installation token หรือ JWT ออก response
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, isUlid, ulid } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import type { GitHubService } from "../github/service";
import { log } from "../logger";
import { authPlugin, requireAuthenticated } from "../plugins/auth";

interface InstallationRow {
  id: string;
  installation_id: number;
  account_login: string;
  account_type: string;
  account_avatar_url: string;
  status: string;
  created_at: number;
  updated_at: number;
}

const installationSchema = t.Object({
  id: t.String(),
  installationId: t.Number(),
  accountLogin: t.String(),
  accountType: t.Union([t.Literal("User"), t.Literal("Organization")]),
  accountAvatarUrl: t.String(),
  status: t.Union([t.Literal("active"), t.Literal("suspended"), t.Literal("deleted")]),
  createdAt: t.Number(),
});

function toInstallation(row: InstallationRow) {
  return {
    id: row.id,
    installationId: row.installation_id,
    accountLogin: row.account_login,
    accountType: row.account_type as "User" | "Organization",
    accountAvatarUrl: row.account_avatar_url,
    status: row.status as "active" | "suspended" | "deleted",
    createdAt: row.created_at,
  };
}

const repoSchema = t.Object({
  id: t.Number(),
  name: t.String(),
  fullName: t.String(),
  private: t.Boolean(),
  defaultBranch: t.String(),
  description: t.Nullable(t.String()),
});

const branchSchema = t.Object({
  name: t.String(),
  protected: t.Boolean(),
});

const sourceBody = t.Object({
  installationId: t.Number({ description: "GitHub installation ID (numeric)" }),
  repoId: t.Number({ description: "GitHub repository ID (numeric, immutable)" }),
  repoFullName: t.String({
    minLength: 3,
    maxLength: 200,
    description: "owner/repo format — validated ผ่าน GitHub API ก่อนบันทึก",
  }),
  branch: t.String({ minLength: 1, maxLength: 255 }),
});

// project schema subset ที่ source endpoints คืน (ไม่ต้องคืน full project)
const projectSourceSchema = t.Object({
  id: t.String(),
  installationId: t.Nullable(t.String()),
  repoId: t.Nullable(t.Number()),
  repoFullName: t.Nullable(t.String()),
  branch: t.Nullable(t.String()),
  updatedAt: t.Number(),
});

interface ProjectSourceRow {
  id: string;
  installation_id: string | null;
  repo_id: number | null;
  repo_full_name: string | null;
  branch: string | null;
  updated_at: number;
}

function assertValidRepoFullName(name: string): void {
  // owner/repo — ทั้งสองส่วนต้อง non-empty, ห้ามมี slash เกิน 1 ตัว
  const parts = name.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AppError("VALIDATION_ERROR", "repoFullName ต้องอยู่ในรูปแบบ owner/repo", {
      field: "repoFullName",
    });
  }
}

export function githubRoutes(db: Database, github: GitHubService | null) {
  /**
   * GitHub app routes — fully chained so Eden treaty picks up all route types.
   *
   * IMPORTANT: Each .get()/.post()/.delete() must be chained (not assigned to a variable
   * and then mutated) — Elysia types each call's return value; mutation-style registration
   * leaves the original variable's type unchanged and Eden treaty can't see the routes.
   */
  const app = new Elysia({ prefix: `${API_PREFIX}/github` })
    .use(authPlugin(db))

    // === Public endpoint — configuration status ===
    .get(
      "/status",
      () => {
        const configured = github !== null;
        const count = configured
          ? (db
              .query<{ count: number }, []>(
                "SELECT COUNT(*) as count FROM github_installations WHERE status = 'active'",
              )
              .get()?.count ?? 0)
          : 0;
        return { configured, activeInstallationCount: count };
      },
      {
        response: t.Object({
          configured: t.Boolean(),
          activeInstallationCount: t.Number(),
        }),
      },
    )

    // === Auth-required endpoints ===
    .guard({ beforeHandle: requireAuthenticated })

    // install URL
    .get(
      "/install-url",
      () => {
        if (!github) {
          throw new AppError(
            "GITHUB_UNAVAILABLE",
            "GitHub App ยังไม่ได้ configure — ตั้งค่า ZIXPLOY_GITHUB_* environment variables",
          );
        }
        return { url: github.getInstallUrl() };
      },
      { response: t.Object({ url: t.String() }) },
    )

    // callback หลัง install GitHub App
    .get(
      "/callback",
      async ({ query, set }) => {
        if (!github) {
          set.status = 302;
          set.headers = { location: "/#github=not-configured" };
          return;
        }

        const installationId = Number(query.installation_id);
        if (!installationId || Number.isNaN(installationId)) {
          set.status = 302;
          set.headers = { location: "/#github=error" };
          return;
        }

        try {
          const data = await github.fetchInstallation(installationId);

          // upsert — ถ้า reinstall เดิม ให้ update ไม่สร้างซ้ำ
          const existing = db
            .query<{ id: string; status: string }, [number]>(
              "SELECT id, status FROM github_installations WHERE installation_id = ?",
            )
            .get(installationId);

          const now = Date.now();
          if (existing) {
            db.query(
              "UPDATE github_installations SET account_login = ?, account_type = ?, account_avatar_url = ?, status = 'active', updated_at = ? WHERE id = ?",
            ).run(data.accountLogin, data.accountType, data.accountAvatarUrl, now, existing.id);
            log.info("github installation updated", {
              installationId,
              accountLogin: data.accountLogin,
            });
          } else {
            const id = ulid();
            db.query(
              "INSERT INTO github_installations (id, installation_id, account_login, account_type, account_avatar_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
            ).run(
              id,
              installationId,
              data.accountLogin,
              data.accountType,
              data.accountAvatarUrl,
              now,
              now,
            );
            log.info("github installation stored", {
              installationId,
              accountLogin: data.accountLogin,
            });
          }

          set.status = 302;
          set.headers = { location: `/?github=installed&account=${data.accountLogin}` };
        } catch (err) {
          log.error("github callback failed", {
            installationId,
            reason: err instanceof Error ? err.message : String(err),
          });
          set.status = 302;
          set.headers = { location: "/#github=error" };
        }
      },
      {
        query: t.Object({
          installation_id: t.Optional(t.String()),
          setup_action: t.Optional(t.String()),
        }),
      },
    )

    // list stored installations
    .get(
      "/installations",
      () => {
        const rows = db
          .query<InstallationRow, []>(
            `SELECT id, installation_id, account_login, account_type, account_avatar_url, status, created_at, updated_at
             FROM github_installations
             WHERE status != 'deleted'
             ORDER BY created_at DESC`,
          )
          .all();
        return { items: rows.map(toInstallation) };
      },
      { response: t.Object({ items: t.Array(installationSchema) }) },
    )

    // list repositories (live from GitHub API)
    .get(
      "/installations/:installationId/repositories",
      async ({ params, query }) => {
        if (!github) {
          throw new AppError("GITHUB_UNAVAILABLE", "GitHub App ยังไม่ได้ configure");
        }

        const installationId = Number(params.installationId);
        if (!installationId || Number.isNaN(installationId)) {
          throw new AppError("VALIDATION_ERROR", "installationId ไม่ถูกต้อง");
        }

        // ตรวจว่า installation นี้อยู่ในระบบของเรา
        const row = db
          .query<{ status: string }, [number]>(
            "SELECT status FROM github_installations WHERE installation_id = ?",
          )
          .get(installationId);

        if (!row) {
          throw new AppError("INSTALLATION_NOT_FOUND", "ไม่พบ GitHub installation นี้");
        }
        if (row.status === "suspended") {
          throw new AppError(
            "GITHUB_UNAVAILABLE",
            "GitHub installation นี้ถูก suspend — ตรวจสอบ GitHub App settings",
          );
        }
        if (row.status === "deleted") {
          throw new AppError("INSTALLATION_NOT_FOUND", "GitHub installation นี้ถูกถอนการติดตั้งแล้ว");
        }

        const page = Math.max(1, Number(query.page ?? 1));
        const perPage = Math.min(100, Math.max(1, Number(query.per_page ?? 30)));

        const result = await github.listRepos(installationId, { page, perPage });
        return {
          items: result.items,
          totalCount: result.totalCount,
          page: result.page,
          perPage: result.perPage,
        };
      },
      {
        params: t.Object({ installationId: t.String() }),
        query: t.Object({
          page: t.Optional(t.String()),
          per_page: t.Optional(t.String()),
        }),
        response: t.Object({
          items: t.Array(repoSchema),
          totalCount: t.Number(),
          page: t.Number(),
          perPage: t.Number(),
        }),
      },
    )

    // list branches (live from GitHub API)
    .get(
      "/branches",
      async ({ query }) => {
        if (!github) {
          throw new AppError("GITHUB_UNAVAILABLE", "GitHub App ยังไม่ได้ configure");
        }

        const installationId = Number(query.installationId);
        if (!installationId || Number.isNaN(installationId)) {
          throw new AppError("VALIDATION_ERROR", "installationId ไม่ถูกต้อง");
        }

        const { repo } = query;
        if (!repo) {
          throw new AppError("VALIDATION_ERROR", "ต้องระบุ repo (owner/repo)");
        }
        assertValidRepoFullName(repo);

        const page = Math.max(1, Number(query.page ?? 1));
        const perPage = Math.min(100, Math.max(1, Number(query.per_page ?? 100)));

        const branches = await github.listBranches(installationId, repo, { page, perPage });
        return { items: branches };
      },
      {
        query: t.Object({
          installationId: t.String(),
          repo: t.String(),
          page: t.Optional(t.String()),
          per_page: t.Optional(t.String()),
        }),
        response: t.Object({ items: t.Array(branchSchema) }),
      },
    );

  // === Project source endpoints — separate prefix, auth + CSRF required ===
  // Fully chained so Eden treaty picks up POST/DELETE /api/v1/projects/:id/source.
  const projectApp = new Elysia({ prefix: `${API_PREFIX}/projects` })
    .use(authPlugin(db))
    .guard({ beforeHandle: requireAuthenticated })

    .post(
      "/:id/source",
      async ({ params, body }) => {
        if (!github) {
          throw new AppError("GITHUB_UNAVAILABLE", "GitHub App ยังไม่ได้ configure");
        }

        if (!isUlid(params.id)) {
          throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
        }

        const project = db
          .query<{ id: string; archived_at: number | null }, [string]>(
            "SELECT id, archived_at FROM projects WHERE id = ?",
          )
          .get(params.id);

        if (!project) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
        if (project.archived_at !== null) {
          throw new AppError("PROJECT_ARCHIVED", "project นี้ถูก archive แล้ว");
        }

        assertValidRepoFullName(body.repoFullName);

        // ตรวจสอบ installation และสิทธิ์เข้าถึง repo ผ่าน GitHub API จริง
        const installRow = db
          .query<{ id: string; status: string }, [number]>(
            "SELECT id, status FROM github_installations WHERE installation_id = ?",
          )
          .get(body.installationId);

        if (!installRow) {
          throw new AppError("INSTALLATION_NOT_FOUND", "ไม่พบ GitHub installation นี้ในระบบ");
        }
        if (installRow.status !== "active") {
          throw new AppError(
            "GITHUB_UNAVAILABLE",
            "GitHub installation ไม่ได้ active — reinstall หรือ unsuspend ก่อน",
          );
        }

        // validate repo access ผ่าน GitHub API
        const validatedRepo = await github.validateRepo(body.installationId, body.repoFullName);
        if (validatedRepo.id !== body.repoId) {
          throw new AppError(
            "VALIDATION_ERROR",
            "repoId ไม่ตรงกับ repository — ส่ง ID ที่ได้จาก GitHub API โดยตรง",
            { field: "repoId" },
          );
        }

        // validate branch
        await github.validateBranch(body.installationId, body.repoFullName, body.branch);

        // อัปเดต project
        const now = Date.now();
        db.query(
          `UPDATE projects SET
            installation_id = ?,
            repo_id = ?,
            repo_full_name = ?,
            branch = ?,
            updated_at = ?
          WHERE id = ?`,
        ).run(installRow.id, body.repoId, body.repoFullName, body.branch, now, params.id);

        log.info("project source connected", {
          projectId: params.id,
          installationId: body.installationId,
          repoFullName: body.repoFullName,
          branch: body.branch,
        });

        const updated = db
          .query<ProjectSourceRow, [string]>(
            "SELECT id, installation_id, repo_id, repo_full_name, branch, updated_at FROM projects WHERE id = ?",
          )
          .get(params.id)!;

        return {
          id: updated.id,
          installationId: updated.installation_id,
          repoId: updated.repo_id,
          repoFullName: updated.repo_full_name,
          branch: updated.branch,
          updatedAt: updated.updated_at,
        };
      },
      { body: sourceBody, response: projectSourceSchema },
    )

    .delete(
      "/:id/source",
      ({ params }) => {
        if (!isUlid(params.id)) {
          throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
        }

        const project = db
          .query<{ id: string; archived_at: number | null }, [string]>(
            "SELECT id, archived_at FROM projects WHERE id = ?",
          )
          .get(params.id);

        if (!project) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
        if (project.archived_at !== null) {
          throw new AppError("PROJECT_ARCHIVED", "project นี้ถูก archive แล้ว");
        }

        const now = Date.now();
        db.query(
          "UPDATE projects SET installation_id = NULL, repo_id = NULL, repo_full_name = NULL, branch = NULL, updated_at = ? WHERE id = ?",
        ).run(now, params.id);

        log.info("project source disconnected", { projectId: params.id });

        const updated = db
          .query<ProjectSourceRow, [string]>(
            "SELECT id, installation_id, repo_id, repo_full_name, branch, updated_at FROM projects WHERE id = ?",
          )
          .get(params.id)!;

        return {
          id: updated.id,
          installationId: updated.installation_id,
          repoId: updated.repo_id,
          repoFullName: updated.repo_full_name,
          branch: updated.branch,
          updatedAt: updated.updated_at,
        };
      },
      { response: projectSourceSchema },
    );

  return new Elysia().use(app).use(projectApp);
}
