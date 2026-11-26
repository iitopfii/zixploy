/**
 * บังคับ login ทุกหน้ายกเว้นหน้า /login และกันหน้าของ admin จาก role อื่น
 * ตรวจกับ API จริงเสมอ (ไม่เชื่อ state ฝั่ง client) เพราะ session อาจหมดอายุหรือถูก revoke
 *
 * การกันหน้าตรงนี้เป็นแค่การนำทาง — สิทธิ์จริงตรวจที่ API ทุก request (control-api auth/policy.ts)
 */

/** หน้าที่ไม่ผูกกับโปรเจกต์ — admin เท่านั้น (ตรงกับ adminOnly ใน layouts/default.vue) */
const ADMIN_ONLY_PATHS = [
  "/databases",
  "/monitoring",
  "/docker",
  "/settings/github",
  "/settings/members",
  "/settings/system",
];

export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return;

  const session = useSession();
  if (!session.value.authenticated) await refreshSession();

  if (to.path === "/login") {
    return session.value.authenticated ? navigateTo("/") : undefined;
  }

  if (!session.value.authenticated) {
    return navigateTo({ path: "/login", query: to.path === "/" ? {} : { next: to.fullPath } });
  }

  if (
    session.value.role !== "admin" &&
    ADMIN_ONLY_PATHS.some((path) => to.path === path || to.path.startsWith(`${path}/`))
  ) {
    return navigateTo("/");
  }
});
