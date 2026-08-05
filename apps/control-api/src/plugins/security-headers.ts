import { Elysia } from "elysia";

/**
 * Security headers สำหรับทุก API response (docs/phase-01)
 * Dashboard (Nuxt) ตั้ง CSP ของหน้าเว็บเอง — ที่นี่คุม response ของ API
 */
export const securityHeaders = new Elysia({ name: "security-headers" }).onRequest(({ set }) => {
  set.headers["X-Content-Type-Options"] = "nosniff";
  set.headers["X-Frame-Options"] = "DENY";
  set.headers["Referrer-Policy"] = "no-referrer";
  // API ตอบ JSON เท่านั้น — ไม่ต้องโหลด resource ใด ๆ
  set.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'";
  set.headers["Cache-Control"] = "no-store";
  set.headers["Cross-Origin-Resource-Policy"] = "same-origin";
});
