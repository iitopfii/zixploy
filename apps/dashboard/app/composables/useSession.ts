interface SessionState {
  authenticated: boolean;
  username?: string;
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
