/**
 * Project component routes — multi-container (compose-style) projects, Phase 18
 *
 *   GET    /api/v1/projects/:id/components                 — list component ทั้งหมด
 *   POST   /api/v1/projects/:id/components                 — เพิ่ม component
 *   PATCH  /api/v1/projects/:id/components/:componentId    — แก้ config
 *   DELETE /api/v1/projects/:id/components/:componentId    — ลบ
 *   POST   /api/v1/projects/:id/compose/promote            — เปลี่ยนโปรเจกต์เป็น mode='compose'
 *
 * build component ตั้ง repo/branch ของตัวเองได้ (gitSource, 0.1.25) — ตรวจกับ GitHub ก่อนบันทึก
 *
 * ADR-0002: control-api ไม่แตะ Docker — แค่เขียนแถว project_components/component_deps ให้
 * worker orchestrator เอาไป deploy จริง (Phase C) · ของเดิม (mode='single') ไม่เกี่ยวข้องเลย
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, HEALTH_CHECK_LIMITS, isUlid } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import type { GitHubAppRegistry } from "../github/registry";
import { authPlugin, requireAuthenticated } from "../plugins/auth";
import {
  assertGitSourceFormat,
  type ComponentGitSource,
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
const gitSourceSchema = t.Object({
  installationId: t.Number({ description: "GitHub installation ID (numeric)" }),
  repoFullName: t.String({ minLength: 3, maxLength: 200 }),
  branch: t.String({ minLength: 1, maxLength: 255 }),
});
const dependsOnSchema = t.Array(
  t.Object({
    name: t.String({ minLength: 1, maxLength: 31 }),
    condition: t.Optional(t.Union([t.Literal("started"), t.Literal("healthy")])),
  }),
);

const healthLimit = (l: { min: number; max: number }) => ({ minimum: l.min, maximum: l.max });

const componentSchema = t.Object({
  id: t.String(),
  projectId: t.String(),
  name: t.String(),
  role: roleSchema,
  sourceKind: sourceKindSchema,
  dockerfilePath: t.Nullable(t.String()),
  buildContext: t.Nullable(t.String()),
  targetStage: t.Nullable(t.String()),
  gitSource: t.Nullable(gitSourceSchema),
  imageRef: t.Nullable(t.String()),
  managedServiceId: t.Nullable(t.String()),
  command: t.Nullable(t.String()),
  internalPort: t.Nullable(t.Number()),
  isWeb: t.Boolean(),
  webPort: t.Nullable(t.Number()),
  healthCheckPath: t.Nullable(t.String()),
  healthCheckIntervalSec: t.Number(),
  healthCheckTimeoutSec: t.Number(),
  healthCheckRetries: t.Number(),
  healthCmd: t.Nullable(t.String()),
  cpuLimit: t.Nullable(t.Number()),
  memoryLimitMb: t.Nullable(t.Number()),
  memorySwapMb: t.Nullable(t.Number()),
  pidsLimit: t.Nullable(t.Number()),
  capDropAll: t.Boolean(),
  noNewPrivileges: t.Boolean(),
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
  gitSource: t.Optional(t.Nullable(gitSourceSchema)),
  imageRef: t.Optional(t.Nullable(t.String({ maxLength: 255 }))),
  managedServiceId: t.Optional(t.Nullable(t.String())),
  command: t.Optional(t.Nullable(t.String({ maxLength: 4096 }))),
  internalPort: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 65535 }))),
  isWeb: t.Optional(t.Boolean()),
  webPort: t.Optional(t.Nullable(t.Integer({ minimum: 1, maximum: 65535 }))),
  healthCheckPath: t.Optional(t.Nullable(t.String({ maxLength: 255 }))),
  healthCheckIntervalSec: t.Optional(t.Integer(healthLimit(HEALTH_CHECK_LIMITS.intervalSec))),
  healthCheckTimeoutSec: t.Optional(t.Integer(healthLimit(HEALTH_CHECK_LIMITS.timeoutSec))),
  healthCheckRetries: t.Optional(t.Integer(healthLimit(HEALTH_CHECK_LIMITS.retries))),
  healthCmd: t.Optional(t.Nullable(t.String({ maxLength: 1024 }))),
  cpuLimit: t.Optional(t.Nullable(t.Number({ minimum: 0.1, maximum: 64 }))),
  memoryLimitMb: t.Optional(t.Nullable(t.Integer({ minimum: 16, maximum: 65536 }))),
  memorySwapMb: t.Optional(t.Nullable(t.Integer({ minimum: 16, maximum: 131072 }))),
  pidsLimit: t.Optional(t.Nullable(t.Integer({ minimum: 16, maximum: 32768 }))),
  capDropAll: t.Optional(t.Boolean()),
  noNewPrivileges: t.Optional(t.Boolean()),
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
  healthCheckIntervalSec: t.Optional(t.Integer(healthLimit(HEALTH_CHECK_LIMITS.intervalSec))),
  healthCheckTimeoutSec: t.Optional(t.Integer(healthLimit(HEALTH_CHECK_LIMITS.timeoutSec))),
  healthCheckRetries: t.Optional(t.Integer(healthLimit(HEALTH_CHECK_LIMITS.retries))),
  healthCmd: t.Optional(t.Nullable(t.String({ maxLength: 1024 }))),
  cpuLimit: t.Optional(t.Nullable(t.Number({ minimum: 0.1, maximum: 64 }))),
  memoryLimitMb: t.Optional(t.Nullable(t.Integer({ minimum: 16, maximum: 65536 }))),
  memorySwapMb: t.Optional(t.Nullable(t.Integer({ minimum: 16, maximum: 131072 }))),
  pidsLimit: t.Optional(t.Nullable(t.Integer({ minimum: 16, maximum: 32768 }))),
  capDropAll: t.Optional(t.Boolean()),
  noNewPrivileges: t.Optional(t.Boolean()),
  restartPolicy: t.Optional(restartSchema),
  enabled: t.Optional(t.Boolean()),
  dockerfilePath: t.Optional(t.Nullable(t.String({ maxLength: 255 }))),
  buildContext: t.Optional(t.Nullable(t.String({ maxLength: 255 }))),
  targetStage: t.Optional(t.Nullable(t.String({ maxLength: 128 }))),
  gitSource: t.Optional(t.Nullable(gitSourceSchema)),
  imageRef: t.Optional(t.Nullable(t.String({ maxLength: 255 }))),
  dependsOn: t.Optional(dependsOnSchema),
});

/**
 * ตรวจว่า installation เข้าถึง repo และ branch นี้ได้จริงก่อนบันทึก — พิมพ์ผิดรู้ตอนตั้งค่า ไม่ใช่ตอน deploy
 * ไม่มี registry (tests บางชุด) = ข้าม ตรวจรูปแบบที่ store อย่างเดียว
 */
async function verifyGitSource(
  registry: GitHubAppRegistry | undefined,
  source: ComponentGitSource | null | undefined,
): Promise<void> {
  if (!source) return;
  assertGitSourceFormat(source);
  if (!registry) return;
  const service = await registry.getServiceForInstallation(source.installationId);
  if (!service) {
    throw new AppError("GITHUB_UNAVAILABLE", "GitHub App ของ installation นี้ไม่พร้อมใช้งาน");
  }
  await service.validateRepo(source.installationId, source.repoFullName);
  await service.validateBranch(source.installationId, source.repoFullName, source.branch);
}

function requireProject(db: Database, projectId: string): void {
  if (!isUlid(projectId)) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
  const row = db
    .query<{ id: string }, [string]>("SELECT id FROM projects WHERE id = ? AND archived_at IS NULL")
    .get(projectId);
  if (!row) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
}

export function componentRoutes(db: Database, registry?: GitHubAppRegistry) {
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
      async ({ params, body, set }) => {
        requireProject(db, params.id);
        await verifyGitSource(registry, body.gitSource);
        const created = createComponent(db, params.id, body);
        set.status = 201;
        return created;
      },
      { body: createBody, response: componentSchema },
    )

    .patch(
      "/projects/:id/components/:componentId",
      async ({ params, body }) => {
        requireProject(db, params.id);
        if (!isUlid(params.componentId))
          throw new AppError("COMPONENT_NOT_FOUND", "ไม่พบ component นี้");
        await verifyGitSource(registry, body.gitSource);
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
