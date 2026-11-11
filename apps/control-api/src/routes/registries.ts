/**
 * Container registry credentials API (0.1.24)
 *
 * GET    /api/v1/registries              — รายการ (ไม่มี password)
 * POST   /api/v1/registries              — เพิ่ม credential ของ registry host
 * PATCH  /api/v1/registries/:registryId  — เปลี่ยน username และ/หรือ password (password ส่งใหม่ทั้งค่า)
 * DELETE /api/v1/registries/:registryId
 *
 * ระดับระบบ (ไม่ผูก project) — ทุก deploy ที่ pull image จาก host นั้นใช้ credential เดียวกัน
 * ผลเหมือน docker login แต่ไม่ค้างบนเครื่อง (worker เขียน DOCKER_CONFIG ชั่วคราวต่อการ pull)
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, isUlid, normalizeRegistryHost } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import { getClientIp, recordAuditEvent } from "../audit/log";
import type { MasterKeys } from "../crypto/master-key";
import { authPlugin, requireAuthenticated } from "../plugins/auth";
import {
  createRegistry,
  deleteRegistry,
  listRegistries,
  updateRegistry,
} from "../registries/store";

const registrySchema = t.Object({
  id: t.String(),
  registry: t.String(),
  username: t.String(),
  lastUsedAt: t.Nullable(t.Number()),
  createdAt: t.Number(),
  updatedAt: t.Number(),
});

const createBody = t.Object({
  registry: t.String({ minLength: 1, maxLength: 253 }),
  username: t.String({ minLength: 1, maxLength: 255 }),
  /** token/password — เช่น GitHub PAT ที่มี scope read:packages สำหรับ ghcr.io */
  password: t.String({ minLength: 1, maxLength: 4096 }),
});

const updateBody = t.Object({
  username: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
  password: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
});

function requireEncryption(masterKeys: MasterKeys | null): MasterKeys {
  if (!masterKeys) {
    throw new AppError(
      "REGISTRY_ENCRYPTION_NOT_CONFIGURED",
      "ยังไม่ได้ตั้งค่า master key — ตั้ง ZIXPLOY_MASTER_KEY_FILE ก่อนเก็บ credential ของ registry",
    );
  }
  return masterKeys;
}

function requireId(id: string): string {
  if (!isUlid(id)) throw new AppError("REGISTRY_NOT_FOUND", "ไม่พบ registry นี้");
  return id;
}

export function registryRoutes(db: Database, masterKeys: MasterKeys | null = null) {
  return new Elysia({ prefix: `${API_PREFIX}/registries` })
    .use(authPlugin(db))
    .guard({ beforeHandle: requireAuthenticated })

    .get("/", () => ({ registries: listRegistries(db) }), {
      response: t.Object({ registries: t.Array(registrySchema) }),
    })

    .post(
      "/",
      async ({ body, set, request, requireSession }) => {
        const session = requireSession();
        const keys = requireEncryption(masterKeys);
        let registry: string;
        try {
          registry = normalizeRegistryHost(body.registry);
        } catch (err) {
          throw new AppError(
            "REGISTRY_INVALID",
            err instanceof Error ? err.message : "registry ไม่ถูกต้อง",
            { field: "registry" },
          );
        }
        const created = await createRegistry(db, keys, {
          registry,
          username: body.username.trim(),
          password: body.password,
        });
        recordAuditEvent(db, {
          actorUserId: session.userId,
          action: "registry_created",
          resourceType: "registry",
          resourceId: created.id,
          metadata: { registry: created.registry },
          ip: getClientIp(request),
        });
        set.status = 201;
        return created;
      },
      { body: createBody, response: registrySchema },
    )

    .patch(
      "/:registryId",
      async ({ params, body, request, requireSession }) => {
        const session = requireSession();
        const keys = requireEncryption(masterKeys);
        const updated = await updateRegistry(db, keys, requireId(params.registryId), {
          ...(body.username !== undefined ? { username: body.username.trim() } : {}),
          ...(body.password !== undefined ? { password: body.password } : {}),
        });
        recordAuditEvent(db, {
          actorUserId: session.userId,
          action: "registry_updated",
          resourceType: "registry",
          resourceId: updated.id,
          metadata: { registry: updated.registry, passwordChanged: body.password !== undefined },
          ip: getClientIp(request),
        });
        return updated;
      },
      { body: updateBody, response: registrySchema },
    )

    .delete(
      "/:registryId",
      ({ params, request, requireSession }) => {
        const session = requireSession();
        deleteRegistry(db, requireId(params.registryId));
        recordAuditEvent(db, {
          actorUserId: session.userId,
          action: "registry_deleted",
          resourceType: "registry",
          resourceId: params.registryId,
          ip: getClientIp(request),
        });
        return { ok: true };
      },
      { response: t.Object({ ok: t.Boolean() }) },
    );
}
