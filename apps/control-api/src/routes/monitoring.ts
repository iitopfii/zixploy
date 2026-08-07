/**
 * Monitoring Routes — Phase 9 M3
 *
 *   GET /api/v1/system/metrics              — CPU/RAM/disk/load ของ host
 *   GET /api/v1/projects/:id/metrics        — CPU/RAM/restart ของ container ราย project
 *
 * Security:
 *   - ต้อง authenticate ทั้งสอง endpoint (metrics เปิดเผยข้อมูล infrastructure)
 *     ต่างจาก /system/health ที่เปิดสาธารณะเพราะ load balancer ต้องเรียกได้
 *   - control-api ไม่แตะ Docker socket / ไม่อ่าน /proc (architecture.test.ts guard)
 *     ข้อมูลทั้งหมดมาจาก SQLite ที่ worker เขียนไว้ (ADR-0002)
 *   - range ถูก clamp ที่ MONITORING.maxRangeMs — query ที่ขอย้อนหลังเกิน retention
 *     scan ทั้งตารางฟรี ๆ โดยไม่ได้ข้อมูลเพิ่ม
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, isUlid, MONITORING } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import { activeMaintenance, enqueueMaintenance, recentMaintenance } from "../maintenance/store";
import {
  downsampleByPeak,
  latestContainerPoint,
  latestHostPoint,
  listContainerPoints,
  listHostPoints,
  resolveRange,
} from "../monitoring/store";
import { authPlugin, requireAuthenticated } from "../plugins/auth";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const hostPointSchema = t.Object({
  ts: t.Number(),
  cpuPercent: t.Number(),
  memUsedBytes: t.Number(),
  memTotalBytes: t.Number(),
  diskUsedBytes: t.Number(),
  diskTotalBytes: t.Number(),
  load1: t.Number(),
  load5: t.Number(),
  load15: t.Number(),
  cpuCount: t.Number(),
});

const containerPointSchema = t.Object({
  ts: t.Number(),
  cpuPercent: t.Number(),
  memUsedBytes: t.Number(),
  memLimitBytes: t.Number(),
  restartCount: t.Number(),
  running: t.Boolean(),
});

const maintenanceSchema = t.Object({
  id: t.String(),
  type: t.Union([
    t.Literal("prune_build_cache"),
    t.Literal("prune_images"),
    t.Literal("prune_all"),
  ]),
  status: t.Union([
    t.Literal("pending"),
    t.Literal("leased"),
    t.Literal("done"),
    t.Literal("failed"),
  ]),
  reclaimedBytes: t.Nullable(t.Number()),
  summary: t.Nullable(t.String()),
  failureMessage: t.Nullable(t.String()),
  createdAt: t.Number(),
  finishedAt: t.Nullable(t.Number()),
});

const rangeSchema = t.Object({
  fromTs: t.Number(),
  toTs: t.Number(),
  /** ความถี่ที่ worker เก็บจริง — UI ใช้ตัดสินว่าช่องว่างในกราฟคือ "ไม่มีข้อมูล" หรือแค่ห่างปกติ */
  sampleIntervalMs: t.Number(),
});

/** ?range=1h|6h|24h — จำกัดเป็นค่าที่กำหนดไว้ ไม่รับ ms ดิบจาก client */
const RANGE_PRESETS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

const querySchema = t.Object({
  range: t.Optional(t.Union([t.Literal("1h"), t.Literal("6h"), t.Literal("24h")])),
});

function requireProject(db: Database, projectId: string): void {
  if (!isUlid(projectId)) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
  const row = db
    .query<{ id: string }, [string]>("SELECT id FROM projects WHERE id = ? AND archived_at IS NULL")
    .get(projectId);
  if (!row) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
}

// ---------------------------------------------------------------------------
// Route module
// ---------------------------------------------------------------------------

export function monitoringRoutes(db: Database) {
  return (
    new Elysia({ prefix: API_PREFIX })
      .use(authPlugin(db))
      .guard({ beforeHandle: requireAuthenticated })

      // GET /system/metrics
      .get(
        "/system/metrics",
        ({ query }) => {
          const { fromTs, toTs } = resolveRange(RANGE_PRESETS[query.range ?? "1h"]);
          const points = listHostPoints(db, fromTs);

          return {
            range: { fromTs, toTs, sampleIntervalMs: MONITORING.sampleIntervalMs },
            latest: latestHostPoint(db),
            points: downsampleByPeak(points, MONITORING.maxSeriesPoints),
          };
        },
        {
          query: querySchema,
          response: t.Object({
            range: rangeSchema,
            latest: t.Nullable(hostPointSchema),
            points: t.Array(hostPointSchema),
          }),
        },
      )

      // ── Maintenance (Phase 11) ──
      // GET /system/maintenance — งานที่ค้างอยู่ + ประวัติล่าสุด
      .get(
        "/system/maintenance",
        () => ({
          active: activeMaintenance(db),
          recent: recentMaintenance(db, 5),
        }),
        {
          response: t.Object({
            active: t.Nullable(maintenanceSchema),
            recent: t.Array(maintenanceSchema),
          }),
        },
      )

      // POST /system/maintenance/cleanup — สั่งล้าง cache (worker เป็นคนทำจริง)
      .post(
        "/system/maintenance/cleanup",
        ({ body, set, session }) => {
          // เก็บ userId ไม่ใช่ username — username เปลี่ยนได้ แต่ id คงที่ (ตามที่ audit log ทำ)
          const job = enqueueMaintenance(db, body.type ?? "prune_all", session?.userId ?? null);
          set.status = 202;
          return job;
        },
        {
          body: t.Object({
            type: t.Optional(
              t.Union([
                t.Literal("prune_build_cache"),
                t.Literal("prune_images"),
                t.Literal("prune_all"),
              ]),
            ),
          }),
          response: maintenanceSchema,
        },
      )

      // GET /projects/:id/metrics
      .get(
        "/projects/:id/metrics",
        ({ params, query }) => {
          requireProject(db, params.id);
          const { fromTs, toTs } = resolveRange(RANGE_PRESETS[query.range ?? "1h"]);
          const points = listContainerPoints(db, params.id, fromTs);

          return {
            range: { fromTs, toTs, sampleIntervalMs: MONITORING.sampleIntervalMs },
            latest: latestContainerPoint(db, params.id),
            points: downsampleByPeak(points, MONITORING.maxSeriesPoints),
          };
        },
        {
          query: querySchema,
          response: t.Object({
            range: rangeSchema,
            latest: t.Nullable(containerPointSchema),
            points: t.Array(containerPointSchema),
          }),
        },
      )
  );
}
