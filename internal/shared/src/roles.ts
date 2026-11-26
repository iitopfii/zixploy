/**
 * Role ของสมาชิก (0.1.28)
 *
 *   admin      ทำได้ทุกอย่าง รวมจัดการสมาชิกและตั้งค่าระบบ เห็นทุกโปรเจกต์
 *   developer  deploy และแก้ไขได้ เฉพาะโปรเจกต์ที่เป็นสมาชิก
 *   viewer     ดูอย่างเดียว เฉพาะโปรเจกต์ที่เป็นสมาชิก
 */
export const USER_ROLES = ["admin", "developer", "viewer"] as const;

export type UserRole = (typeof USER_ROLES)[number];

const ROLE_RANK: Record<UserRole, number> = { viewer: 0, developer: 1, admin: 2 };

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}

/** role นี้มีสิทธิ์อย่างน้อยเท่า `min` หรือไม่ */
export function roleAtLeast(role: UserRole, min: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}
