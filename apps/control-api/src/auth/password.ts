/**
 * Password hashing ด้วย Argon2id (docs/phase-01)
 * ใช้ Bun.password ซึ่งมี Argon2id ในตัวและเปรียบเทียบแบบ constant-time
 */

const ARGON2ID = {
  algorithm: "argon2id",
  memoryCost: 19456, // 19 MiB — OWASP baseline สำหรับ Argon2id
  timeCost: 2,
} as const;

export const PASSWORD_MIN_LENGTH = 12;

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  return Bun.password.hash(plain, ARGON2ID);
}

/** คืน false เมื่อไม่ตรง — ไม่โยน error เพื่อไม่ให้แยกแยะสาเหตุจากภายนอก */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(plain, hash);
  } catch {
    return false;
  }
}
