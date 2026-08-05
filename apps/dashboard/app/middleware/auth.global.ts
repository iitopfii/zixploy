/**
 * บังคับ login ทุกหน้ายกเว้นหน้า /login
 * ตรวจกับ API จริงเสมอ (ไม่เชื่อ state ฝั่ง client) เพราะ session อาจหมดอายุหรือถูก revoke
 */
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
});
