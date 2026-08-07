/**
 * Managed Service Routes — Phase 10 M2
 *
 *   GET    /api/v1/service-catalog              — template ที่เลือกได้ (ไม่ต้อง auth ก็ได้ แต่กันไว้)
 *   GET    /api/v1/services                     — list
 *   POST   /api/v1/services                     — create + enqueue provision
 *   GET    /api/v1/services/:id                 — detail
 *   PATCH  /api/v1/services/:id                 — แก้ config (ต้อง stopped)
 *   DELETE /api/v1/services/:id                 — enqueue destroy
 *   GET    /api/v1/services/:id/credentials     — รหัสผ่าน + connection string
 *   POST   /api/v1/services/:id/start|stop|restart
 *
 * Security:
 * - รหัสผ่านไม่อยู่ใน list/detail — ต้องเรียก /credentials ที่แยกต่างหากโดยตั้งใจ
 * - control-api ไม่แตะ Docker (ADR-0002) — ทุก operation เขียนเป็น job ให้ worker ทำ
 * - image/version มาจาก catalog เท่านั้น ไม่รับ image ref จากผู้ใช้
 */

import type { Database } from "bun:sqlite";
import {
  API_PREFIX,
  AppError,
  connectionUri,
  getTemplate,
  isUlid,
  SERVICE_CATALOG,
  SERVICE_SETTINGS,
  SERVICE_TYPES,
  serviceContainerName,
} from "@zixploy/shared";
import { Elysia, t } from "elysia";
import type { MasterKeys } from "../crypto/master-key";
import { authPlugin, requireAuthenticated } from "../plugins/auth";
import { enqueueServiceJob, hasPendingJob } from "../services/queue";
import {
  createService,
  credentialsOf,
  decryptPassword,
  listServices,
  requireService,
  toDto,
  updateService,
} from "../services/store";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * ต้องเขียน literal ตรง ๆ ไม่ใช่ SERVICE_TYPES.map(t.Literal) — TypeBox ต้องการ tuple ที่รู้
 * ชนิดตอน compile time ถ้า map จาก array runtime จะ infer เป็น never แล้ว handler ทุกตัวพัง
 * (เทสต์ใน internal/shared/test/services.test.ts บังคับว่าสองที่นี้ต้องตรงกันเสมอ)
 */
const serviceTypeSchema = t.Union([
  t.Literal("postgres"),
  t.Literal("mysql"),
  t.Literal("mariadb"),
  t.Literal("redis"),
  t.Literal("mongodb"),
  t.Literal("libsql"),
]);

const statusSchema = t.Union([
  t.Literal("creating"),
  t.Literal("starting"),
  t.Literal("running"),
  t.Literal("stopped"),
  t.Literal("failed"),
  t.Literal("deleting"),
]);

const serviceSchema = t.Object({
  id: t.String(),
  name: t.String(),
  type: serviceTypeSchema,
  version: t.String(),
  image: t.String(),
  status: statusSchema,
  username: t.String(),
  databaseName: t.String(),
  internalPort: t.Number(),
  exposedPort: t.Nullable(t.Number()),
  memoryLimitMb: t.Nullable(t.Number()),
  cpuLimit: t.Nullable(t.Number()),
  failureMessage: t.Nullable(t.String()),
  createdAt: t.Number(),
  updatedAt: t.Number(),
  lastStartedAt: t.Nullable(t.Number()),
  /** มีงานค้างอยู่ไหม — UI ใช้ปิดปุ่มและแสดง spinner */
  busy: t.Boolean(),
});

const createBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 60 }),
  type: serviceTypeSchema,
  version: t.Optional(t.String({ maxLength: 40 })),
  exposedPort: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 65535 }))),
  memoryLimitMb: t.Optional(t.Nullable(t.Integer({ minimum: 64, maximum: 65536 }))),
  cpuLimit: t.Optional(t.Nullable(t.Number({ minimum: 0.1, maximum: 64 }))),
});

const updateBody = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 60 })),
  exposedPort: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 65535 }))),
  memoryLimitMb: t.Optional(t.Nullable(t.Integer({ minimum: 64, maximum: 65536 }))),
  cpuLimit: t.Optional(t.Nullable(t.Number({ minimum: 0.1, maximum: 64 }))),
});

const catalogEntrySchema = t.Object({
  type: serviceTypeSchema,
  displayName: t.String(),
  tagline: t.String(),
  category: t.Union([t.Literal("sql"), t.Literal("nosql"), t.Literal("cache")]),
  versions: t.Array(t.String()),
  defaultVersion: t.String(),
  internalPort: t.Number(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireUlid(id: string): void {
  if (!isUlid(id)) throw new AppError("SERVICE_NOT_FOUND", "ไม่พบ service นี้");
}

/** DTO + busy flag — busy คำนวณจาก service_jobs ทุกครั้งที่อ่าน */
function present(db: Database, id: string) {
  const row = requireService(db, id);
  return { ...toDto(row), busy: hasPendingJob(db, id) };
}

// ---------------------------------------------------------------------------
// Route module
// ---------------------------------------------------------------------------

export function serviceRoutes(db: Database, masterKeys: MasterKeys | null) {
  return (
    new Elysia({ prefix: API_PREFIX })
      .use(authPlugin(db))
      .guard({ beforeHandle: requireAuthenticated })

      // GET /service-catalog — template ที่เลือกได้
      .get(
        "/service-catalog",
        () => ({
          items: SERVICE_TYPES.map((type) => {
            const tpl = SERVICE_CATALOG[type];
            return {
              type,
              displayName: tpl.displayName,
              tagline: tpl.tagline,
              category: tpl.category,
              versions: [...tpl.versions],
              defaultVersion: tpl.versions[0] as string,
              internalPort: tpl.internalPort,
            };
          }),
        }),
        { response: t.Object({ items: t.Array(catalogEntrySchema) }) },
      )

      // GET /services
      .get(
        "/services",
        () => ({
          items: listServices(db).map((s) => ({ ...s, busy: hasPendingJob(db, s.id) })),
        }),
        { response: t.Object({ items: t.Array(serviceSchema) }) },
      )

      // POST /services
      .post(
        "/services",
        async ({ body, set }) => {
          const created = await createService(db, masterKeys, {
            name: body.name,
            type: body.type,
            version: body.version ?? null,
            exposedPort: body.exposedPort ?? null,
            memoryLimitMb: body.memoryLimitMb ?? null,
            cpuLimit: body.cpuLimit ?? null,
          });
          enqueueServiceJob(db, created.id, "provision");
          set.status = 201;
          return present(db, created.id);
        },
        { body: createBody, response: serviceSchema },
      )

      // GET /services/:id
      .get(
        "/services/:id",
        ({ params }) => {
          requireUlid(params.id);
          return present(db, params.id);
        },
        { response: serviceSchema },
      )

      // PATCH /services/:id
      .patch(
        "/services/:id",
        ({ params, body }) => {
          requireUlid(params.id);
          updateService(db, params.id, body);
          return present(db, params.id);
        },
        { body: updateBody, response: serviceSchema },
      )

      // DELETE /services/:id — soft: ตั้ง status=deleting แล้วให้ worker ลบ container/volume จริง
      .delete(
        "/services/:id",
        ({ params, set }) => {
          requireUlid(params.id);
          requireService(db, params.id);
          db.query("UPDATE services SET status = 'deleting', updated_at = ? WHERE id = ?").run(
            Date.now(),
            params.id,
          );
          enqueueServiceJob(db, params.id, "destroy");
          set.status = 202;
          return present(db, params.id);
        },
        { response: serviceSchema },
      )

      // GET /services/:id/credentials — endpoint เดียวที่คืนรหัสผ่าน
      .get(
        "/services/:id/credentials",
        async ({ params }) => {
          requireUlid(params.id);
          const row = requireService(db, params.id);
          const password = await decryptPassword(masterKeys, row);
          const creds = credentialsOf(row, password);
          const template = getTemplate(row.type as never);

          // host ภายใน = ชื่อ container ใน Docker network — app อื่นในเครื่องต่อผ่านชื่อนี้
          const internalHost = serviceContainerName(row.id);

          return {
            username: creds.username,
            password: creds.password,
            databaseName: creds.database,
            internalHost,
            internalPort: row.internal_port || template.internalPort,
            exposedPort: row.exposed_port,
            internalUri: connectionUri(row.type as never, creds, internalHost, row.internal_port),
            // มีเฉพาะเมื่อเปิด port ออก host — host จริงผู้ใช้เติมเอง (เราไม่รู้ public IP ที่แน่นอน)
            externalUri: row.exposed_port
              ? connectionUri(row.type as never, creds, "<SERVER_IP>", row.exposed_port)
              : null,
          };
        },
        {
          response: t.Object({
            username: t.String(),
            password: t.String(),
            databaseName: t.String(),
            internalHost: t.String(),
            internalPort: t.Number(),
            exposedPort: t.Nullable(t.Number()),
            internalUri: t.String(),
            externalUri: t.Nullable(t.String()),
          }),
        },
      )

      // Lifecycle operations
      .post(
        "/services/:id/start",
        ({ params, set }) => {
          requireUlid(params.id);
          requireService(db, params.id);
          enqueueServiceJob(db, params.id, "start");
          set.status = 202;
          return present(db, params.id);
        },
        { response: serviceSchema },
      )

      .post(
        "/services/:id/stop",
        ({ params, set }) => {
          requireUlid(params.id);
          requireService(db, params.id);
          enqueueServiceJob(db, params.id, "stop");
          set.status = 202;
          return present(db, params.id);
        },
        { response: serviceSchema },
      )

      .post(
        "/services/:id/restart",
        ({ params, set }) => {
          requireUlid(params.id);
          requireService(db, params.id);
          enqueueServiceJob(db, params.id, "restart");
          set.status = 202;
          return present(db, params.id);
        },
        { response: serviceSchema },
      )
  );
}
