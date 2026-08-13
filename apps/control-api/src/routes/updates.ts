/**
 * Version & self-update routes — Phase 12
 *
 *   GET  /api/v1/system/version         — เวอร์ชันที่รันอยู่ + มีอัปเดตไหม
 *   POST /api/v1/system/update          — สั่งอัปเดต (worker เป็นคนทำ ตาม ADR-0002)
 *
 * control-api ไม่แตะ Docker เลย — แค่สร้างงานลง maintenance_jobs
 */

import type { Database } from "bun:sqlite";
import {
  API_PREFIX,
  AppError,
  hasUpdate,
  SELF_UPDATE_DISABLED,
  ulid,
  ZIXPLOY_VERSION,
} from "@zixploy/shared";
import { Elysia, t } from "elysia";
import { getClientIp, recordAuditEvent } from "../audit/log";
import { authPlugin, requireAuthenticated } from "../plugins/auth";
import { checkForUpdate, clearUpdateCache } from "../updates/check";

const versionSchema = t.Object({
  current: t.String(),
  latest: t.Nullable(t.String()),
  updateAvailable: t.Boolean(),
  checkedAt: t.Number(),
  error: t.Nullable(t.String()),
  /** งานอัปเดตที่กำลังทำอยู่ (ถ้ามี) — UI ใช้แสดง "กำลังอัปเดต…" */
  updating: t.Boolean(),
});

export function updateRoutes(db: Database) {
  return new Elysia({ prefix: `${API_PREFIX}/system` })
    .use(authPlugin(db))
    .guard({ beforeHandle: requireAuthenticated })

    .get(
      "/version",
      async ({ query }) => {
        const status = await checkForUpdate(query.refresh === "true");
        const active = db
          .query<{ id: string }, []>(
            "SELECT id FROM maintenance_jobs WHERE type = 'self_update' AND status IN ('pending','leased') LIMIT 1",
          )
          .get();
        return { ...status, updating: active != null };
      },
      {
        query: t.Object({ refresh: t.Optional(t.String()) }),
        response: versionSchema,
      },
    )

    .post(
      "/update",
      async ({ body, set, request, requireSession }) => {
        const session = requireSession();

        if (ZIXPLOY_VERSION === "dev" || SELF_UPDATE_DISABLED) {
          throw new AppError(
            "MAINTENANCE_FAILED",
            "ระบบนี้รันจากซอร์สโดยตรง — อัปเดตผ่านหน้าเว็บไม่ได้ ใช้ git pull แทน",
          );
        }

        const status = await checkForUpdate(true);
        const target = body?.version ?? status.latest;

        if (!target) {
          throw new AppError("MAINTENANCE_FAILED", status.error ?? "ตรวจไม่พบเวอร์ชันใหม่บน registry");
        }
        // กันสั่งอัปเดตไปเวอร์ชันที่เก่ากว่าหรือเท่าเดิมโดยไม่ตั้งใจ
        if (!body?.version && !hasUpdate(ZIXPLOY_VERSION, target)) {
          throw new AppError("MAINTENANCE_FAILED", `ใช้เวอร์ชัน ${ZIXPLOY_VERSION} ล่าสุดอยู่แล้ว`);
        }

        const now = Date.now();
        const id = ulid();
        try {
          db.query(
            `INSERT INTO maintenance_jobs
                 (id, type, status, target_version, from_version, requested_by, created_at, updated_at)
               VALUES (?, 'self_update', 'pending', ?, ?, ?, ?, ?)`,
          ).run(id, target, ZIXPLOY_VERSION, session.userId, now, now);
        } catch (err) {
          if (err instanceof Error && err.message.includes("UNIQUE")) {
            throw new AppError("MAINTENANCE_BUSY", "มีงานระบบกำลังทำงานอยู่ — รอให้เสร็จก่อนสั่งอัปเดต");
          }
          throw err;
        }

        recordAuditEvent(db, {
          actorUserId: session.userId,
          action: "system_update_requested",
          resourceType: "system",
          resourceId: id,
          metadata: { from: ZIXPLOY_VERSION, to: target },
          ip: getClientIp(request),
        });

        clearUpdateCache();
        set.status = 202;
        return { jobId: id, from: ZIXPLOY_VERSION, to: target };
      },
      {
        body: t.Optional(t.Object({ version: t.Optional(t.String({ maxLength: 40 })) })),
        response: t.Object({ jobId: t.String(), from: t.String(), to: t.String() }),
      },
    );
}
