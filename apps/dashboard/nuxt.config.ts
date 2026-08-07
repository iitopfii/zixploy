export default defineNuxtConfig({
  compatibilityDate: "2026-08-01",
  devtools: { enabled: false },
  typescript: { strict: true },
  css: ["~/assets/main.css"],
  // SPA เท่านั้น — dashboard เรียก Control API ผ่านคุกกี้ ไม่ต้อง render ฝั่ง server
  ssr: false,
  app: {
    head: {
      title: "Zixploy · Deployment Platform",
      htmlAttrs: { lang: "th" },
      meta: [
        { charset: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { name: "description", content: "Zixploy — Deployment Platform" },
        // สีแถบ URL บนมือถือให้ตรงกับพื้นหลังแอป (--bg) ไม่ให้เห็นแถบขาวคาดบนสุด
        { name: "theme-color", content: "#0a0c11" },
      ],
      link: [
        // ico ไว้ก่อนสำหรับเบราว์เซอร์เก่า/pinned tab, png ตามหลังให้ตัวที่รองรับเลือกใช้
        { rel: "icon", href: "/favicon.ico", sizes: "any" },
        { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon-32x32.png" },
        { rel: "icon", type: "image/png", sizes: "16x16", href: "/favicon-16x16.png" },
        { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
      ],
    },
  },
  nitro: {
    // local dev: proxy /api ไป Control API — production ให้ Traefik route แทน
    devProxy: {
      "/api": { target: "http://127.0.0.1:3001/api", changeOrigin: true },
    },
  },
});
