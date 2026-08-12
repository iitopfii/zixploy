/**
 * System settings routes (Phase 14)
 *
 *   GET /api/v1/system/settings — dashboard domain ที่ตั้งไว้ + IP ของเครื่อง (สำหรับตั้ง A record)
 *   PUT /api/v1/system/settings — ตั้ง/ล้าง dashboard domain (auth + CSRF)
 *
 * dashboard domain มีผลทันทีไม่ต้อง restart — origin-guard อ่านผ่าน SettingsStore ที่ cache
 * ใน memory และอัปเดตพร้อมกันตอน PUT (ดู settings/store.ts, plugins/origin-guard.ts)
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, validateHostname } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import { getClientIp, recordAuditEvent } from "../audit/log";
import { loadConfiguredIps } from "../domains/dns-check";
import { authPlugin, requireAuthenticated } from "../plugins/auth";
import type { SettingsStore } from "../settings/store";

const settingsSchema = t.Object({
  dashboardDomain: t.Nullable(t.String()),
  /** IP ของเครื่องจาก ZIXPLOY_PUBLIC_IPS — UI แสดงเป็น A record ที่ต้องตั้งใน DNS */
  serverIps: t.Array(t.String()),
});

const updateBody = t.Object({
  // null = ล้าง domain (กลับไปใช้เฉพาะ ZIXPLOY_BASE_URL)
  dashboardDomain: t.Nullable(t.String({ maxLength: 253 })),
});

export function systemSettingsRoutes(db: Database, settings: SettingsStore) {
  const toResponse = () => ({
    dashboardDomain: settings.getDashboardDomain(),
    serverIps: loadConfiguredIps(),
  });

  return new Elysia({ prefix: `${API_PREFIX}/system` })
    .use(authPlugin(db))
    .guard({ beforeHandle: requireAuthenticated })

    .get("/settings", toResponse, { response: settingsSchema })

    .put(
      "/settings",
      ({ body, request, requireSession }) => {
        const session = requireSession();

        // validateHostname (ห้าม scheme/path/wildcard/IP — ตัวเดียวกับที่ใช้ตรวจ domain ของ
        // project จึงเข้มเท่ากันทั้งระบบ) โยน plain Error — แปลงเป็น 400 ให้ UI แสดงข้อความได้
        let domain: string | null;
        try {
          domain = body.dashboardDomain === null ? null : validateHostname(body.dashboardDomain);
        } catch (err) {
          throw new AppError(
            "VALIDATION_ERROR",
            err instanceof Error ? err.message : "domain ไม่ถูกต้อง",
            { field: "dashboardDomain" },
          );
        }
        settings.setDashboardDomain(domain);

        recordAuditEvent(db, {
          actorUserId: session.userId,
          action: "system_settings_updated",
          resourceType: "system",
          resourceId: "settings",
          metadata: { dashboardDomain: domain },
          ip: getClientIp(request),
        });

        return toResponse();
      },
      { body: updateBody, response: settingsSchema },
    );
}
