/**
 * Dockerfile-paste source (Phase 13) — ทางเลือกแทนการเชื่อม GitHub repository
 *
 * GET  /api/v1/projects/:id/source/dockerfile  — auth, อ่านเนื้อหาที่บันทึกไว้ (สำหรับฟอร์มแก้ไข)
 * POST /api/v1/projects/:id/source/dockerfile  — auth + CSRF, ตั้ง/แก้ไข source เป็น Dockerfile ที่วางเอง
 *
 * ตั้ง source_type = 'dockerfile' แล้วล้าง GitHub fields ทั้งหมด (mutual exclusive กับ routes/github.ts
 * ซึ่งทำย้อนกลับตอนเชื่อม/ยกเลิก GitHub) บังคับ dockerfile_path='Dockerfile', build_context='.' เสมอ
 * เพราะ workspace ของ build แบบนี้มีไฟล์เดียวที่ผู้ใช้วางเอง ไม่มี git clone มาเติม (ดู pipeline/build.ts)
 *
 * เนื้อหาที่วางเป็น input ที่ไม่น่าเชื่อถือเหมือน repo ภายนอก — ผ่าน build sandbox เดียวกันทุกอย่าง
 * (BUILD_SANDBOX_LIMITS, --secret ไม่ใช่ --build-arg, assertDockerfileWithinContext) ไม่มีข้อยกเว้น
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, isUlid } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import { log } from "../logger";
import { authPlugin, requireAuthenticated } from "../plugins/auth";

// 64KB เกินพอสำหรับ Dockerfile จริง — กันวางเนื้อหาผิดขนาดมหึมาเข้ามาโดยไม่ตั้งใจ
const MAX_DOCKERFILE_BYTES = 64 * 1024;

const dockerfileBody = t.Object({
  dockerfile: t.String({ minLength: 1, maxLength: MAX_DOCKERFILE_BYTES }),
});

const dockerfileSourceSchema = t.Object({
  id: t.String(),
  sourceType: t.Union([t.Literal("github"), t.Literal("dockerfile")]),
  dockerfile: t.Nullable(t.String()),
  updatedAt: t.Number(),
});

interface ProjectRow {
  id: string;
  archived_at: number | null;
  source_type: string;
  dockerfile_content: string | null;
  updated_at: number;
}

function loadProject(db: Database, id: string): ProjectRow {
  if (!isUlid(id)) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
  const row = db
    .query<ProjectRow, [string]>(
      "SELECT id, archived_at, source_type, dockerfile_content, updated_at FROM projects WHERE id = ?",
    )
    .get(id);
  if (!row) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
  if (row.archived_at !== null) {
    throw new AppError("PROJECT_ARCHIVED", "project นี้ถูก archive แล้ว");
  }
  return row;
}

function toResponse(row: ProjectRow) {
  return {
    id: row.id,
    sourceType: row.source_type as "github" | "dockerfile",
    dockerfile: row.dockerfile_content,
    updatedAt: row.updated_at,
  };
}

export function dockerfileSourceRoutes(db: Database) {
  return new Elysia({ prefix: `${API_PREFIX}/projects` })
    .use(authPlugin(db))
    .guard({ beforeHandle: requireAuthenticated })

    .get("/:id/source/dockerfile", ({ params }) => toResponse(loadProject(db, params.id)), {
      response: dockerfileSourceSchema,
    })

    .post(
      "/:id/source/dockerfile",
      ({ params, body }) => {
        loadProject(db, params.id);

        const now = Date.now();
        db.query(
          `UPDATE projects SET
             source_type = 'dockerfile',
             dockerfile_content = ?,
             dockerfile_path = 'Dockerfile',
             build_context = '.',
             installation_id = NULL,
             repo_id = NULL,
             repo_full_name = NULL,
             branch = NULL,
             updated_at = ?
           WHERE id = ?`,
        ).run(body.dockerfile, now, params.id);

        log.info("project source set to pasted dockerfile", { projectId: params.id });

        return toResponse(loadProject(db, params.id));
      },
      { body: dockerfileBody, response: dockerfileSourceSchema },
    );
}
