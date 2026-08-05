export default defineNuxtConfig({
  compatibilityDate: "2026-08-01",
  devtools: { enabled: false },
  typescript: { strict: true },
  nitro: {
    // local dev: proxy /api ไป Control API — production ให้ Traefik route แทน
    devProxy: {
      "/api": { target: "http://127.0.0.1:3001/api", changeOrigin: true },
    },
  },
});
