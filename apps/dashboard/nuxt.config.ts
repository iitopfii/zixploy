export default defineNuxtConfig({
  compatibilityDate: "2026-08-01",
  devtools: { enabled: false },
  typescript: { strict: true },
  css: ["~/assets/main.css"],
  // SPA เท่านั้น — dashboard เรียก Control API ผ่านคุกกี้ ไม่ต้อง render ฝั่ง server
  ssr: false,
  nitro: {
    // local dev: proxy /api ไป Control API — production ให้ Traefik route แทน
    devProxy: {
      "/api": { target: "http://127.0.0.1:3001/api", changeOrigin: true },
    },
  },
});
