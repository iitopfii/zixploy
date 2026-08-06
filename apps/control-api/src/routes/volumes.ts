/**
 * Volume Routes — docs/phase-07-volumes.md
 *
 * GET    /api/v1/projects/:id/volumes
 * POST   /api/v1/projects/:id/volumes
 * PATCH  /api/v1/projects/:id/volumes/:volumeId
 * POST   /api/v1/projects/:id/volumes/:volumeId/detach
 * DELETE /api/v1/projects/:id/volumes/:volumeId
 * POST   /api/v1/projects/:id/volumes/:volumeId/inspect
 *
 * Security:
 * - mount path ผ่าน validateMountPath() ก่อน store (reject /proc, /sys, /dev, /etc ฯลฯ)
 * - docker_name สร้างจาก volumeName(projectId, volumeId) — ไม่ใช้ user input ใน Docker name
 * - ห้ามลบ active volume โดยตรง — ต้อง detach ก่อน
 * - control-api ไม่แตะ Docker (architecture.test.ts guard) — Worker ทำ docker volume create/rm
 * - inspect endpoint คืนสถานะจาก DB (last-known state) เท่านั้น
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, isUlid } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import { authPlugin, requireAuthenticated } from "../plugins/auth";
import {
  createVolume,
  detachVolume,
  getVolume,
  listVolumes,
  markVolumeForDeletion,
  updateVolume,
} from "../volumes/store";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const lifecycleSchema = t.Union([
  t.Literal("active"),
  t.Literal("detached"),
  t.Literal("deletion_pending"),
  t.Literal("deleted"),
  t.Literal("error"),
]);

const accessModeSchema = t.Union([t.Literal("shared-safe"), t.Literal("single-writer")]);

const volumeSchema = t.Object({
  id: t.String(),
  projectId: t.String(),
  displayName: t.String(),
  dockerName: t.String(),
  mountPath: t.String(),
  accessMode: accessModeSchema,
  driver: t.String(),
  driverOpts: t.Record(t.String(), t.String()),
  readOnly: t.Boolean(),
  lifecycle: lifecycleSchema,
  lastAttachedAt: t.Nullable(t.Number()),
  createdAt: t.Number(),
  updatedAt: t.Number(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireProject(db: Database, id: string): void {
  if (!isUlid(id)) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
  const row = db
    .query<{ id: string }, [string]>("SELECT id FROM projects WHERE id = ? AND archived_at IS NULL")
    .get(id);
  if (!row) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
}

function requireVolume(db: Database, volumeId: string, projectId: string) {
  if (!isUlid(volumeId)) throw new AppError("VOLUME_NOT_FOUND", "ไม่พบ volume นี้");
  const vol = getVolume(db, volumeId);
  if (!vol || vol.projectId !== projectId) {
    throw new AppError("VOLUME_NOT_FOUND", "ไม่พบ volume นี้");
  }
  return vol;
}

// ---------------------------------------------------------------------------
// Route module
// ---------------------------------------------------------------------------

export function volumeRoutes(db: Database) {
  return (
    new Elysia()
      .use(authPlugin(db))
      .guard({ beforeHandle: requireAuthenticated })

      // GET /api/v1/projects/:id/volumes
      .get(
        `${API_PREFIX}/projects/:id/volumes`,
        ({ params }) => {
          requireProject(db, params.id);
          return { volumes: listVolumes(db, params.id) };
        },
        { response: t.Object({ volumes: t.Array(volumeSchema) }) },
      )

      // POST /api/v1/projects/:id/volumes
      .post(
        `${API_PREFIX}/projects/:id/volumes`,
        ({ params, body }) => {
          requireProject(db, params.id);
          const vol = createVolume(db, params.id, {
            displayName: body.displayName,
            mountPath: body.mountPath,
            ...(body.accessMode !== undefined ? { accessMode: body.accessMode } : {}),
            ...(body.driver !== undefined ? { driver: body.driver } : {}),
            ...(body.readOnly !== undefined ? { readOnly: body.readOnly } : {}),
          });
          return { volume: vol };
        },
        {
          body: t.Object({
            displayName: t.String({ minLength: 1, maxLength: 100 }),
            mountPath: t.String({ minLength: 1 }),
            accessMode: t.Optional(accessModeSchema),
            driver: t.Optional(t.String()),
            readOnly: t.Optional(t.Boolean()),
          }),
          response: t.Object({ volume: volumeSchema }),
        },
      )

      // PATCH /api/v1/projects/:id/volumes/:volumeId
      .patch(
        `${API_PREFIX}/projects/:id/volumes/:volumeId`,
        ({ params, body }) => {
          requireProject(db, params.id);
          requireVolume(db, params.volumeId, params.id);
          const vol = updateVolume(db, params.volumeId, params.id, {
            ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
            ...(body.mountPath !== undefined ? { mountPath: body.mountPath } : {}),
            ...(body.accessMode !== undefined ? { accessMode: body.accessMode } : {}),
            ...(body.readOnly !== undefined ? { readOnly: body.readOnly } : {}),
          });
          return { volume: vol };
        },
        {
          body: t.Object({
            displayName: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
            mountPath: t.Optional(t.String({ minLength: 1 })),
            accessMode: t.Optional(accessModeSchema),
            readOnly: t.Optional(t.Boolean()),
          }),
          response: t.Object({ volume: volumeSchema }),
        },
      )

      // POST /api/v1/projects/:id/volumes/:volumeId/detach
      .post(
        `${API_PREFIX}/projects/:id/volumes/:volumeId/detach`,
        ({ params }) => {
          requireProject(db, params.id);
          requireVolume(db, params.volumeId, params.id);
          const vol = detachVolume(db, params.volumeId, params.id);
          return { volume: vol };
        },
        { response: t.Object({ volume: volumeSchema }) },
      )

      // DELETE /api/v1/projects/:id/volumes/:volumeId
      // ตั้ง lifecycle = 'deletion_pending'; Worker ทำ docker volume rm จริงใน reconcile loop
      .delete(
        `${API_PREFIX}/projects/:id/volumes/:volumeId`,
        ({ params }) => {
          requireProject(db, params.id);
          requireVolume(db, params.volumeId, params.id);
          markVolumeForDeletion(db, params.volumeId, params.id);
          return { ok: true };
        },
        { response: t.Object({ ok: t.Boolean() }) },
      )

      // POST /api/v1/projects/:id/volumes/:volumeId/inspect
      // คืนสถานะจาก DB เท่านั้น (last-known Docker state ที่ worker อัปเดตไว้)
      // control-api ไม่เรียก Docker ตาม architecture.test.ts guard
      .post(
        `${API_PREFIX}/projects/:id/volumes/:volumeId/inspect`,
        ({ params }) => {
          requireProject(db, params.id);
          const vol = requireVolume(db, params.volumeId, params.id);
          return { volume: vol };
        },
        { response: t.Object({ volume: volumeSchema }) },
      )
  );
}
