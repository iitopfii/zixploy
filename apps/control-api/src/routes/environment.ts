/**
 * Environment Variables API — docs/phase-04-environment.md
 *
 * GET    /api/v1/projects/:id/environment        → metadata list (no plaintext)
 * PUT    /api/v1/projects/:id/environment        → full replace
 * POST   /api/v1/projects/:id/environment/import → parse .env content (no DB change)
 * POST   /api/v1/projects/:id/environment/validate → validate key list
 *
 * secret values ไม่ปรากฏใน response ใด ๆ — คืนแค่ hasValue: true
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, ENV_VAR_KEY_RE, isUlid } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import type { MasterKeys } from "../crypto/master-key";
import { parseEnvContent } from "../env/parser";
import { listEnvVars, replaceEnvVars } from "../env/store";
import { authPlugin, requireAuthenticated } from "../plugins/auth";

// ---------------------------------------------------------------------------
// Elysia schemas
// ---------------------------------------------------------------------------

const envVarSummarySchema = t.Object({
  id: t.String(),
  key: t.String(),
  isSecret: t.Boolean(),
  hasValue: t.Literal(true),
  scope: t.Union([t.Literal("runtime"), t.Literal("build"), t.Literal("both")]),
  enabled: t.Boolean(),
  version: t.Number(),
  createdAt: t.Number(),
  updatedAt: t.Number(),
});

const envVarInputSchema = t.Object({
  key: t.String({ minLength: 1, maxLength: 256 }),
  value: t.String({ maxLength: 65536 }),
  isSecret: t.Optional(t.Boolean()),
  scope: t.Optional(t.Union([t.Literal("runtime"), t.Literal("build"), t.Literal("both")])),
  enabled: t.Optional(t.Boolean()),
});

const putBodySchema = t.Object({
  variables: t.Array(envVarInputSchema, { maxItems: 500 }),
});

const importBodySchema = t.Object({
  content: t.String({ maxLength: 1_000_000 }),
});

const validateBodySchema = t.Object({
  variables: t.Array(t.Object({ key: t.String({ minLength: 1, maxLength: 256 }) }), {
    maxItems: 500,
  }),
});

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

function requireProject(db: Database, projectId: string): void {
  if (!isUlid(projectId)) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
  const row = db
    .query<{ id: string }, [string]>("SELECT id FROM projects WHERE id = ? AND archived_at IS NULL")
    .get(projectId);
  if (!row) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
}

function requireEncryption(masterKeys: MasterKeys | null): MasterKeys {
  if (!masterKeys) {
    throw new AppError(
      "ENV_ENCRYPTION_NOT_CONFIGURED",
      "ยังไม่ได้ตั้งค่า master key — ตั้ง ZIXPLOY_MASTER_KEY_FILE ก่อนจัดการ environment variables",
    );
  }
  return masterKeys;
}

// ---------------------------------------------------------------------------
// Route module
// ---------------------------------------------------------------------------

export function environmentRoutes(db: Database, masterKeys: MasterKeys | null) {
  return (
    new Elysia({ prefix: `${API_PREFIX}/projects/:id/environment` })
      .use(authPlugin(db))
      .guard({ beforeHandle: requireAuthenticated })

      // GET /projects/:id/environment — metadata only, no plaintext
      .get(
        "/",
        ({ params }) => {
          requireProject(db, params.id);
          return { variables: listEnvVars(db, params.id) };
        },
        {
          response: t.Object({ variables: t.Array(envVarSummarySchema) }),
        },
      )

      // PUT /projects/:id/environment — full replace (encrypted server-side)
      .put(
        "/",
        async ({ params, body }) => {
          requireProject(db, params.id);
          const keys = requireEncryption(masterKeys);
          const variables = await replaceEnvVars(db, params.id, body.variables, keys);
          return { variables };
        },
        {
          body: putBodySchema,
          response: t.Object({ variables: t.Array(envVarSummarySchema) }),
        },
      )

      // POST /projects/:id/environment/import — parse .env, no DB change
      .post(
        "/import",
        ({ params, body }) => {
          requireProject(db, params.id);
          // masterKeys ไม่จำเป็นสำหรับ parse-only — แต่ผู้เรียก PUT ต้องมี key เองก่อน save จริง
          const { vars, warnings } = parseEnvContent(body.content);
          return {
            parsed: vars.map((v) => ({
              key: v.key,
              value: v.value,
              lineNumber: v.lineNumber,
            })),
            warnings,
          };
        },
        {
          body: importBodySchema,
          response: t.Object({
            parsed: t.Array(
              t.Object({ key: t.String(), value: t.String(), lineNumber: t.Number() }),
            ),
            warnings: t.Array(t.String()),
          }),
        },
      )

      // POST /projects/:id/environment/validate — validate key format + duplicates
      .post(
        "/validate",
        ({ params, body }) => {
          requireProject(db, params.id);
          const errors: Array<{ key: string; message: string }> = [];
          const seen = new Set<string>();

          for (const v of body.variables) {
            if (!ENV_VAR_KEY_RE.test(v.key)) {
              errors.push({
                key: v.key,
                message: `ต้องขึ้นต้นด้วยตัวอักษรหรือ underscore และมีเฉพาะ [A-Za-z0-9_]`,
              });
            } else if (seen.has(v.key)) {
              errors.push({ key: v.key, message: "key ซ้ำ" });
            }
            seen.add(v.key);
          }

          return { valid: errors.length === 0, errors };
        },
        {
          body: validateBodySchema,
          response: t.Object({
            valid: t.Boolean(),
            errors: t.Array(t.Object({ key: t.String(), message: t.String() })),
          }),
        },
      )
  );
}
