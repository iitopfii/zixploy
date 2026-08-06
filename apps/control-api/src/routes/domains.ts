/**
 * Domain Routes — docs/phase-05-domains.md M3
 *
 * GET    /api/v1/projects/:id/domains
 * POST   /api/v1/projects/:id/domains
 * PATCH  /api/v1/projects/:id/domains/:domainId
 * DELETE /api/v1/projects/:id/domains/:domainId
 * POST   /api/v1/projects/:id/domains/:domainId/check   (DNS check)
 *
 * Security:
 * - hostname ทุกตัวผ่าน validateHostname() ก่อน insert/update
 * - ไม่รับ raw Traefik label จากผู้ใช้ — labels สร้างจาก DB เท่านั้น (buildTraefikLabels)
 * - response ไม่ส่ง internal column ที่ไม่จำเป็น
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, isUlid, validateHostname } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import { checkDns, loadConfiguredIps } from "../domains/dns-check";
import {
  createDomain,
  deleteDomain,
  getDomain,
  listDomains,
  updateDnsStatus,
  updateDomain,
} from "../domains/store";
import { authPlugin, requireAuthenticated } from "../plugins/auth";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const redirectModeSchema = t.Union([
  t.Literal("none"),
  t.Literal("www_to_root"),
  t.Literal("root_to_www"),
]);

const dnsStatusSchema = t.Union([
  t.Literal("pending"),
  t.Literal("valid"),
  t.Literal("mismatch"),
  t.Literal("unknown"),
]);

const domainSchema = t.Object({
  id: t.String(),
  projectId: t.String(),
  hostname: t.String(),
  internalPort: t.Number(),
  httpsEnabled: t.Boolean(),
  redirectHttp: t.Boolean(),
  redirectMode: redirectModeSchema,
  dnsStatus: dnsStatusSchema,
  dnsCheckedAt: t.Nullable(t.Number()),
  enabled: t.Boolean(),
  createdAt: t.Number(),
  updatedAt: t.Number(),
});

const createBody = t.Object({
  hostname: t.String({ minLength: 1, maxLength: 253 }),
  internalPort: t.Integer({ minimum: 1, maximum: 65535 }),
  httpsEnabled: t.Optional(t.Boolean()),
  redirectHttp: t.Optional(t.Boolean()),
  redirectMode: t.Optional(redirectModeSchema),
});

const updateBody = t.Object({
  internalPort: t.Optional(t.Integer({ minimum: 1, maximum: 65535 })),
  httpsEnabled: t.Optional(t.Boolean()),
  redirectHttp: t.Optional(t.Boolean()),
  redirectMode: t.Optional(redirectModeSchema),
  enabled: t.Optional(t.Boolean()),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireProject(db: Database, projectId: string): void {
  if (!isUlid(projectId)) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
  const row = db
    .query<{ id: string }, [string]>("SELECT id FROM projects WHERE id = ? AND archived_at IS NULL")
    .get(projectId);
  if (!row) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
}

function requireDomainBelongsToProject(
  db: Database,
  domainId: string,
  projectId: string,
): NonNullable<ReturnType<typeof getDomain>> {
  if (!isUlid(domainId)) throw new AppError("DOMAIN_NOT_FOUND", "ไม่พบ domain นี้");
  const row = getDomain(db, domainId);
  if (!row || row.project_id !== projectId) {
    throw new AppError("DOMAIN_NOT_FOUND", "ไม่พบ domain นี้");
  }
  return row;
}

// ---------------------------------------------------------------------------
// Route module
// ---------------------------------------------------------------------------

export function domainRoutes(db: Database) {
  return (
    new Elysia({ prefix: `${API_PREFIX}/projects/:id/domains` })
      .use(authPlugin(db))
      .guard({ beforeHandle: requireAuthenticated })

      // GET /projects/:id/domains
      .get(
        "/",
        ({ params }) => {
          requireProject(db, params.id);
          return { domains: listDomains(db, params.id) };
        },
        { response: t.Object({ domains: t.Array(domainSchema) }) },
      )

      // POST /projects/:id/domains
      .post(
        "/",
        ({ params, body, set }) => {
          requireProject(db, params.id);

          // validate + normalize hostname
          let hostname: string;
          try {
            hostname = validateHostname(body.hostname);
          } catch (err) {
            throw new AppError(
              "DOMAIN_INVALID",
              err instanceof Error ? err.message : "hostname ไม่ถูกต้อง",
            );
          }

          const domain = createDomain(db, params.id, {
            hostname,
            internalPort: body.internalPort,
            ...(body.httpsEnabled !== undefined ? { httpsEnabled: body.httpsEnabled } : {}),
            ...(body.redirectHttp !== undefined ? { redirectHttp: body.redirectHttp } : {}),
            ...(body.redirectMode !== undefined ? { redirectMode: body.redirectMode } : {}),
          });
          set.status = 201;
          return domain;
        },
        { body: createBody, response: domainSchema },
      )

      // PATCH /projects/:id/domains/:domainId
      .patch(
        "/:domainId",
        ({ params, body }) => {
          requireProject(db, params.id);
          requireDomainBelongsToProject(db, params.domainId, params.id);
          return updateDomain(db, params.domainId, body);
        },
        { body: updateBody, response: domainSchema },
      )

      // DELETE /projects/:id/domains/:domainId
      .delete(
        "/:domainId",
        ({ params, set }) => {
          requireProject(db, params.id);
          requireDomainBelongsToProject(db, params.domainId, params.id);
          deleteDomain(db, params.domainId);
          set.status = 204;
          return null;
        },
        { response: t.Null() },
      )

      // POST /projects/:id/domains/:domainId/check — DNS check
      .post(
        "/:domainId/check",
        async ({ params }) => {
          requireProject(db, params.id);
          const row = requireDomainBelongsToProject(db, params.domainId, params.id);

          const configuredIps = loadConfiguredIps();
          const result = await checkDns(row.hostname, configuredIps);
          const updated = updateDnsStatus(db, params.domainId, result.status);

          return {
            domain: updated,
            check: {
              resolvedAddresses: result.resolvedAddresses,
              configuredIps: result.configuredIps,
            },
          };
        },
        {
          response: t.Object({
            domain: domainSchema,
            check: t.Object({
              resolvedAddresses: t.Array(t.String()),
              configuredIps: t.Array(t.String()),
            }),
          }),
        },
      )
  );
}
