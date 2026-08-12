/**
 * System settings store (Phase 14) — ค่าที่แก้ได้จาก dashboard โดยไม่ต้อง restart
 *
 * ตอนนี้มีค่าเดียว: dashboard_domain — host เพิ่มเติมที่ origin-guard ยอมรับนอกเหนือจาก
 * ZIXPLOY_BASE_URL แก้ปัญหา INVALID_HOST เวลาผู้ใช้เข้า dashboard ผ่าน domain ที่ตั้งทีหลัง
 * (เช่นชี้ domain ใหม่มาที่เครื่องหลังติดตั้งเสร็จ) โดยไม่ต้อง SSH ไปแก้ .env
 *
 * cache ใน memory เพราะ origin-guard เรียกทุก request — อ่าน DB แค่ตอนสร้าง store และ
 * เขียนทับ cache ทันทีตอน set (control-api มี instance เดียว ไม่มีปัญหา cache stale ข้ามเครื่อง)
 */

import type { Database } from "bun:sqlite";

const KEY_DASHBOARD_DOMAIN = "dashboard_domain";

export interface SettingsStore {
  getDashboardDomain(): string | null;
  setDashboardDomain(domain: string | null): void;
}

export function createSettingsStore(db: Database): SettingsStore {
  let dashboardDomain: string | null =
    db
      .query<{ value: string }, [string]>("SELECT value FROM system_settings WHERE key = ?")
      .get(KEY_DASHBOARD_DOMAIN)?.value ?? null;

  return {
    getDashboardDomain() {
      return dashboardDomain;
    },

    setDashboardDomain(domain: string | null) {
      const now = Date.now();
      if (domain === null) {
        db.query("DELETE FROM system_settings WHERE key = ?").run(KEY_DASHBOARD_DOMAIN);
      } else {
        db.query(
          `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).run(KEY_DASHBOARD_DOMAIN, domain, now);
      }
      dashboardDomain = domain;
    },
  };
}
