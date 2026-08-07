/**
 * Domain Routes — docs/phase-05-domains.md M3
 *
 * GET    /api/v1/projects/:id/domains
 * POST   /api/v1/projects/:id/domains
 * PATCH  /api/v1/projects/:id/domains/:domainId
 * DELETE /api/v1/projects/:id/domains/:domainId
 * POST   /api/v1/projects/:id/domains/:domainId/check   (DNS check)
 * PUT    /api/v1/projects/:id/domains/:domainId/certificate  (upload custom TLS — M5)
 * DELETE /api/v1/projects/:id/domains/:domainId/certificate  (กลับไปใช้ Let's Encrypt)
 *
 * Security:
 * - hostname ทุกตัวผ่าน validateHostname() ก่อน insert/update
 * - ไม่รับ raw Traefik label จากผู้ใช้ — labels สร้างจาก DB เท่านั้น (buildTraefikLabels)
 * - response ไม่ส่ง internal column ที่ไม่จำเป็น
 * - **ไม่มี GET certificate**: private key ที่อัปโหลดแล้วต้องอ่านกลับออกมาไม่ได้เลย
 *   ต้องการเปลี่ยน = อัปโหลดทับ ต้องการเลิกใช้ = DELETE
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, isUlid, MAX_PEM_BYTES, validateHostname } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import type { MasterKeys } from "../crypto/master-key";
import { checkDns, loadConfiguredIps } from "../domains/dns-check";
import {
  createDomain,
  deleteDomain,
  getDomain,
  listDomains,
  updateDnsStatus,
  updateDomain,
} from "../domains/store";
import { getCertificateInfo, removeCertificate, uploadCertificate } from "../domains/tls-store";
import { syncCertificates } from "../domains/tls-sync";
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
  t.Literal("proxied"),
  t.Literal("unknown"),
]);

const tlsModeSchema = t.Union([t.Literal("letsencrypt"), t.Literal("custom")]);

/** metadata ของ certificate — ไม่มี PEM ใด ๆ ในนี้โดยตั้งใจ (ดู header comment) */
const certificateInfoSchema = t.Object({
  fingerprint: t.String(),
  subject: t.String(),
  issuer: t.String(),
  hostnames: t.Array(t.String()),
  notBefore: t.Number(),
  notAfter: t.Number(),
  uploadedAt: t.Number(),
  selfSigned: t.Boolean(),
});

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
  tlsMode: tlsModeSchema,
  tlsCertFingerprint: t.Nullable(t.String()),
  tlsCertNotAfter: t.Nullable(t.Number()),
  enabled: t.Boolean(),
  createdAt: t.Number(),
  updatedAt: t.Number(),
});

const uploadCertificateBody = t.Object({
  /** full chain PEM — leaf ใบแรก ตามด้วย intermediate (ไม่ต้องมี root) */
  certificate: t.String({ minLength: 1, maxLength: MAX_PEM_BYTES }),
  /** private key PEM — ห้ามมี passphrase (Traefik อ่านไม่ได้) */
  privateKey: t.String({ minLength: 1, maxLength: MAX_PEM_BYTES }),
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

/** อ่าน DomainDto กลับหลัง mutation — store คืน Row จึงต้องผ่าน listDomains ที่ map เป็น DTO */
function loadDomainDto(db: Database, projectId: string, domainId: string) {
  const dto = listDomains(db, projectId).find((d) => d.id === domainId);
  if (!dto) throw new AppError("INTERNAL_ERROR", "domain หายไประหว่างดำเนินการ");
  return dto;
}

// ---------------------------------------------------------------------------
// Route module
// ---------------------------------------------------------------------------

export function domainRoutes(db: Database, masterKeys: MasterKeys | null = null) {
  /**
   * เรียกหลังทุกการเปลี่ยนแปลงที่กระทบ cert บน disk (upload/delete cert, enable/disable
   * domain, ลบ domain) — sync ไม่โยน error โดยออกแบบ ดู tls-sync.ts §Failure policy
   */
  const resync = () => syncCertificates(db, masterKeys);

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
        async ({ params, body }) => {
          requireProject(db, params.id);
          requireDomainBelongsToProject(db, params.domainId, params.id);
          const updated = updateDomain(db, params.domainId, body);
          // enabled toggle เปลี่ยนว่า cert ควรอยู่บน disk หรือไม่ — disabled domain
          // ที่ยังมี cert ค้างจะทำให้ Traefik ตอบ SNI นั้นได้ทั้งที่ไม่มี router
          if (body.enabled !== undefined) await resync();
          return updated;
        },
        { body: updateBody, response: domainSchema },
      )

      // DELETE /projects/:id/domains/:domainId
      .delete(
        "/:domainId",
        async ({ params, set }) => {
          requireProject(db, params.id);
          requireDomainBelongsToProject(db, params.domainId, params.id);
          deleteDomain(db, params.domainId);
          await resync();
          set.status = 204;
          return null;
        },
        { response: t.Null() },
      )

      // PUT /projects/:id/domains/:domainId/certificate — อัปโหลด custom TLS (M5)
      .put(
        "/:domainId/certificate",
        async ({ params, body }) => {
          requireProject(db, params.id);
          requireDomainBelongsToProject(db, params.domainId, params.id);

          const { info } = await uploadCertificate(
            db,
            params.domainId,
            body.certificate,
            body.privateKey,
            masterKeys,
          );
          await resync();
          return { domain: loadDomainDto(db, params.id, params.domainId), certificate: info };
        },
        {
          body: uploadCertificateBody,
          response: t.Object({ domain: domainSchema, certificate: certificateInfoSchema }),
        },
      )

      // DELETE /projects/:id/domains/:domainId/certificate — กลับไปใช้ Let's Encrypt
      .delete(
        "/:domainId/certificate",
        async ({ params }) => {
          requireProject(db, params.id);
          requireDomainBelongsToProject(db, params.domainId, params.id);
          removeCertificate(db, params.domainId);
          await resync();
          return loadDomainDto(db, params.id, params.domainId);
        },
        { response: domainSchema },
      )

      // GET /projects/:id/domains/:domainId/certificate — metadata เท่านั้น ไม่มี PEM
      .get(
        "/:domainId/certificate",
        ({ params }) => {
          requireProject(db, params.id);
          requireDomainBelongsToProject(db, params.domainId, params.id);
          const info = getCertificateInfo(db, params.domainId);
          if (!info) {
            throw new AppError("TLS_CERT_NOT_FOUND", "domain นี้ยังไม่มี custom certificate");
          }
          return info;
        },
        { response: certificateInfoSchema },
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
              cloudflareAddresses: result.cloudflareAddresses,
            },
          };
        },
        {
          response: t.Object({
            domain: domainSchema,
            check: t.Object({
              resolvedAddresses: t.Array(t.String()),
              configuredIps: t.Array(t.String()),
              cloudflareAddresses: t.Array(t.String()),
            }),
          }),
        },
      )
  );
}
