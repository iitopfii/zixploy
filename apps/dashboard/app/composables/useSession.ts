interface SessionState {
  authenticated: boolean;
  username?: string;
  userId?: string;
  role?: "admin" | "developer" | "viewer";
  expiresAt?: number;
}

/**
 * สถานะ session ที่แชร์ทั้งแอป — middleware และ layout อ่านจากที่เดียวกัน
 * ไม่เก็บ token ใด ๆ ไว้ใน state; token อยู่ในคุกกี้ httpOnly เท่านั้น
 */
export function useSession() {
  return useState<SessionState>("session", () => ({ authenticated: false }));
}

/** ถามสถานะจาก API — เรียกตอนเข้าแอปและหลัง login/logout */
export async function refreshSession() {
  const session = useSession();
  const api = useApi();
  const { data } = await api.api.v1.auth.session.get();
  session.value = data ?? { authenticated: false };
  return session.value;
}

/**
 * สิทธิ์ของผู้ใช้ปัจจุบัน — ใช้ซ่อนเมนู/ปุ่มที่ทำไม่ได้
 * เป็นแค่การแสดงผล: API ตรวจสิทธิ์จริงทุก request (control-api auth/policy.ts)
 */
export function usePermissions() {
  const session = useSession();
  const role = computed(() => session.value.role ?? "viewer");
  return {
    role,
    /** จัดการสมาชิก ตั้งค่าระบบ และทุกส่วนที่ไม่ผูกกับโปรเจกต์ */
    isAdmin: computed(() => role.value === "admin"),
    /** deploy และแก้ไขโปรเจกต์ที่เป็นสมาชิก */
    canWrite: computed(() => role.value === "admin" || role.value === "developer"),
  };
}
