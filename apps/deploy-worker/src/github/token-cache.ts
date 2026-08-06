/**
 * In-memory cache สำหรับ GitHub installation access tokens
 *
 * GitHub installation token อายุ 1 ชั่วโมง — เรา cache ไว้ได้แต่หมดอายุก่อน
 * 5 นาที เพื่อ safety margin (clock skew + network latency)
 *
 * ทำไมไม่เก็บลง SQLite:
 * - Token เป็น credential ชั่วคราว — DB = persistent store
 * - หาก DB หลุด จะไม่มี credential ที่ valid หลุดออกไป
 * - Token หมดอายุเองอยู่แล้ว; restart worker = cache ล้างอัตโนมัติ
 *
 * docs/threat-model.md section 4: "GitHub token ระยะยาวรั่ว"
 *
 * หมายเหตุ: duplicated กับ apps/control-api/src/github/token-cache.ts โดยตั้งใจ
 * (ADR-0002 ห้าม RPC ระหว่าง API กับ worker — worker cache token ของตัวเองแยกจาก API)
 */

const SAFETY_MARGIN_MS = 5 * 60 * 1000; // 5 นาที

export interface CachedToken {
  token: string;
  /** เวลาที่ token หมดอายุจริง (GitHub กำหนด) */
  githubExpiresAt: Date;
  /** เวลาที่ cache ถือว่า token หมดอายุ (= githubExpiresAt - safety margin) */
  effectiveExpiresAt: number; // unix ms
}

export class InstallationTokenCache {
  private readonly cache = new Map<number, CachedToken>();

  /**
   * คืน token ถ้ายังไม่หมดอายุตาม effective expiry
   * null = ต้องขอ token ใหม่จาก GitHub API
   */
  get(installationId: number): string | null {
    const entry = this.cache.get(installationId);
    if (!entry) return null;
    if (Date.now() >= entry.effectiveExpiresAt) {
      this.cache.delete(installationId);
      return null;
    }
    return entry.token;
  }

  /**
   * เก็บ token ใหม่ — GitHub ส่ง expires_at เป็น ISO 8601 string
   *
   * @param expiresAt วันเวลาหมดอายุจาก GitHub API response
   */
  set(installationId: number, token: string, expiresAt: Date): void {
    this.cache.set(installationId, {
      token,
      githubExpiresAt: expiresAt,
      effectiveExpiresAt: expiresAt.getTime() - SAFETY_MARGIN_MS,
    });
  }

  /** Invalidate เมื่อ installation ถูก suspend/delete — ป้องกัน token ใช้งานหลัง revoke */
  invalidate(installationId: number): void {
    this.cache.delete(installationId);
  }

  /** ใช้ตอน test teardown */
  invalidateAll(): void {
    this.cache.clear();
  }

  /** ตรวจสอบสถานะ cache (สำหรับ test เท่านั้น) */
  size(): number {
    return this.cache.size;
  }

  /** เวลาหมดอายุที่ cache ถือ (สำหรับ test assertion) */
  getEffectiveExpiry(installationId: number): number | undefined {
    return this.cache.get(installationId)?.effectiveExpiresAt;
  }

  /** เวลาหมดอายุจริงจาก GitHub (ไม่ใช่ effective/margin-adjusted) — worker ใช้คืนใน MintedToken */
  getGithubExpiresAt(installationId: number): Date | undefined {
    return this.cache.get(installationId)?.githubExpiresAt;
  }
}
