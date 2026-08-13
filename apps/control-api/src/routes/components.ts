/**
 * Project component routes — multi-container (compose-style) projects, Phase 18
 *
 *   GET    /api/v1/projects/:id/components                 — list component ทั้งหมด
 *   POST   /api/v1/projects/:id/components                 — เพิ่ม component
 *   PATCH  /api/v1/projects/:id/components/:componentId    — แก้ config
 *   DELETE /api/v1/projects/:id/components/:componentId    — ลบ
 *   POST   /api/v1/projects/:id/compose/promote            — เปลี่ยนโปรเจกต์เป็น mode='compose'
 *
 * ADR-0002: control-api ไม่แตะ Docker — แค่เขียนแถว project_components/component_deps ให้
 * worker orchestrator เอาไป deploy จริง (Phase C) · ของเดิม (mode='single') ไม่เกี่ยวข้องเลย
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, isUlid } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import { authPlugin, requireAuthenticated } from "../plugins/auth";
import {
  createComponent,
  deleteComponent,
  listComponents,
  promoteToCompose,
  updateComponent,
} from "../projects/components-store";

const roleSchema = t.Union([
  t.Literal("web"),
  t.Literal("worker"),
  t.Literal("db"),
  t.Literal("cache"),
  t.Literal("app"),
  t.Literal("other"),
]);
const sourceKindSchema = t.Union([
  t.Literal("build"),
  t.Literal("image"),
  t.Literal("managed_ref"),
]);
const restartSchema = t.Union([
  t.Literal("no"),
  t.Literal("on-failure"),
  t.Literal("always"),
  t.Literal("unless-stopped"),
]);
const dependsOnSchema = t.Array(
  t.Object({
    name: t.String({ minLength: 1, maxLength: 31 }),
    condition: t.Optional(t.Union([t.Literal("started"), t.Literal("healthy")])),
  }),
);

const componentSchema = t.Object({
  id: t.String(),
  projectId: t.String(),
  name: t.String(),
  role: roleSchema,
  sourceKind: sourceKindSchema,
  dockerfilePath: t.Nullable(t.String()),
  buildContext: t.Nullable(t.String()),
  targetStage: t.Nullable(t.String()),
  imageRef: t.Nullable(t.String()),
  managedServiceId: t.Nullable(t.String()),
  command: t.Nullable(t.String()),
  internalPort: t.Nullable(t.Number()),
  isWeb: t.Boolean(),
  webPort: t.Nullable(t.Number()),
  healthCheckPath: t.Nullable(t.String()),
  cpuLimit: t.Nullable(t.Number()),
  memoryLimitMb: t.Nullable(t.Number()),
  restartPolicy: t.String(),
  position: t.Number(),
  enabled: t.Boolean(),
  dependsOn: t.Array(
    t.Object({
      componentId: t.String(),
      name: t.String(),
      condition: t.Union([t.Literal("started"), t.Literal("healthy")]),
    }),
  ),
  createdAt: t.Number(),
  updatedAt: t.Number(),
});

const createBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 31 }),
  role: t.Optional(roleSchema),
  sourceKind: sourceKindSchema,
  dockerfilePath: t.Optional(t.Nullable(t.String({ maxLength: 255 }))),
  buildContext: t.Optional(t.Nullable(t.String({ maxLength: 255 }))),
  targetStage: t.Optional(t.Nullable(t.String({ maxLength: 128 }))),
  imageRef: t.Optional(t.Nullable(t.String({ maxLength: 255 }))),
  managedServiceId: t.Optional(t.Nullable(t.String())),
  command: t.Optional(t.Nullable(t.String({ maxLength: 4096 }))),
  internalPort: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 65535 }))),
  isWeb: t.Optional(t.Boolean()),
  webPort: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 65535 }))),
  healthCheckPath: t.Optional(t.Nullable(t.String({ maxLength: 255 }))),
  cpuLimit: t.Optional(t.Nullable(t.Number({ minimum: 0.1, maximum: 64 }))),
  memoryLimitMb: t.Optional(t.Nullable(t.Integer({ minimum: 16, maximum: 65536 }))),
  restartPolicy: t.Optional(restartSchema),
  dependsOn: t.Optional(dependsOnSchema),
});

const updateBody = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 31 })),
  role: t.Optional(roleSchema),
  command: t.Optional(t.Nullable(t.String({ maxLength: 4096 }))),
  internalPort: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 65535 }))),
  isWeb: t.Optional(t.Boolean()),
  webPort: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 65535 }))),
  healthCheckPath: t.Optional(t.Nullable(t.String({ maxLength: 255 }))),
  cpuLimit: t.Optional(t.Nullable(t.Number({ minimum: 0.1, maximum: 64 }))),
  memoryLimitMb: t.Optional(t.Nullable(t.Integer({ minimum: 16, maximum: 65536 }))),
  restartPolicy: t.Optional(restartSchema),
  enabled: t.Optional(t.Boolean()),
  dockerfilePath: t.Optional(t.Nullable(t.String({ maxLength: 255 }))),
  buildContext: t.Optional(t.Nullable(t.String({ maxLength: 255 }))),
  targetStage: t.Optional(t.Nullable(t.String({ maxLength: 128 }))),
  imageRef: t.Optional(t.Nullable(t.String({ maxLength: 255 }))),
  dependsOn: t.Optional(dependsOnSchema),
});

function requireProject(db: Database, projectId: string): void {
  if (!isUlid(projectId)) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
  const row = db
    .query<{ id: string }, [string]>("SELECT id FROM projects WHERE id = ? AND archived_at IS NULL")
    .get(projectId);
  if (!row) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
}

export function componentRoutes(db: Database) {
  return new Elysia({ prefix: API_PREFIX })
    .use(authPlugin(db))
    .guard({ beforeHandle: requireAuthenticated })

    .get(
      "/projects/:id/components",
      ({ params }) => {
        requireProject(db, params.id);
        return { items: listComponents(db, params.id) };
      },
      { response: t.Object({ items: t.Array(componentSchema) }) },
    )

    .post(
      "/projects/:id/components",
      ({ params, body, set }) => {
        requireProject(db, params.id);
        const created = createComponent(db, params.id, body);
        set.status = 201;
        return created;
      },
      { body: createBody, response: componentSchema },
    )

    .patch(
      "/projects/:id/components/:componentId",
      ({ params, body }) => {
        requireProject(db, params.id);
        if (!isUlid(params.componentId))
          throw new AppError("COMPONENT_NOT_FOUND", "ไม่พบ component นี้");
        return updateComponent(db, params.id, params.componentId, body);
      },
      { body: updateBody, response: componentSchema },
    )

    .delete(
      "/projects/:id/components/:componentId",
      ({ params, set }) => {
        requireProject(db, params.id);
        if (!isUlid(params.componentId))
          throw new AppError("COMPONENT_NOT_FOUND", "ไม่พบ component นี้");
        deleteComponent(db, params.id, params.componentId);
        set.status = 204;
        return null;
      },
      { response: t.Null() },
    )

    .post(
      "/projects/:id/compose/promote",
      ({ params }) => {
        requireProject(db, params.id);
        promoteToCompose(db, params.id);
        return { items: listComponents(db, params.id), mode: "compose" as const };
      },
      {
        response: t.Object({
          items: t.Array(componentSchema),
          mode: t.Literal("compose"),
        }),
      },
    );
}
