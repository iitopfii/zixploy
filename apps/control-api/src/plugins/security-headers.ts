import { Elysia } from "elysia";

/**
 * Security headers สำหรับทุก API response (docs/phase-01, เพิ่ม HSTS/Permissions-Policy ใน Phase 8 M5)
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
  set.headers["Permissions-Policy"] = "geolocation=(), camera=(), microphone=()";
  // HSTS มีความหมายเฉพาะบน HTTPS จริง — production เท่านั้น (Traefik เป็นตัว terminate TLS)
  // ห้ามส่งใน dev/test เพราะ browser จะจำค่านี้ไว้แม้กลับไปใช้ http://localhost
  if (process.env.NODE_ENV === "production") {
    set.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload";
  }
});
