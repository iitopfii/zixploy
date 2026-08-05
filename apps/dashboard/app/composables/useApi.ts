import { treaty } from "@elysiajs/eden";
import type { App } from "@zixploy/control-api/app";

/**
 * Typed API client — types มาจาก Elysia app โดยตรง ไม่ต้องประกาศซ้ำ (docs/phase-01)
 *
 * เรียกผ่าน path เดียวกับเบราว์เซอร์เพื่อให้คุกกี้ session ถูกส่งไปด้วย
 * (dev ใช้ devProxy ของ Nitro, production ให้ Traefik route)
 */
export function useApi() {
  return treaty<App>(useRequestURL().origin, {
    fetch: { credentials: "same-origin" },
    headers() {
      // CSRF double-submit: อ่านคุกกี้ที่ API ตั้งไว้แล้วส่งกลับใน header
      const csrf = useCookie("zx_csrf", { readonly: true }).value;
      return csrf ? { "x-csrf-token": csrf } : {};
    },
  });
}
