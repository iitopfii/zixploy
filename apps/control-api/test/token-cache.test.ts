import { describe, expect, test } from "bun:test";
import { InstallationTokenCache } from "../src/github/token-cache";

describe("InstallationTokenCache", () => {
  test("ไม่มี token ในตอนแรก", () => {
    const cache = new InstallationTokenCache();
    expect(cache.get(12345)).toBeNull();
  });

  test("get token ที่ยังไม่หมดอายุได้", () => {
    const cache = new InstallationTokenCache();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 ชั่วโมงข้างหน้า
    cache.set(12345, "ghp_test_token", expiresAt);
    expect(cache.get(12345)).toBe("ghp_test_token");
  });

  test("คืน null เมื่อ token หมดอายุ (รวม safety margin 5 นาที)", () => {
    const cache = new InstallationTokenCache();
    // หมดอายุ 4 นาทีข้างหน้า — น้อยกว่า safety margin 5 นาที
    const expiresAt = new Date(Date.now() + 4 * 60 * 1000);
    cache.set(12345, "ghp_expiring_soon", expiresAt);
    expect(cache.get(12345)).toBeNull();
  });

  test("คืน token เมื่อ effective expiry ยังไม่ถึง", () => {
    const cache = new InstallationTokenCache();
    // หมดอายุ 6 นาทีข้างหน้า — มากกว่า safety margin 5 นาที
    const expiresAt = new Date(Date.now() + 6 * 60 * 1000);
    cache.set(12345, "ghp_still_valid", expiresAt);
    expect(cache.get(12345)).toBe("ghp_still_valid");
  });

  test("invalidate ลบ token ออกจาก cache", () => {
    const cache = new InstallationTokenCache();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    cache.set(12345, "ghp_token", expiresAt);

    cache.invalidate(12345);
    expect(cache.get(12345)).toBeNull();
    expect(cache.size()).toBe(0);
  });

  test("invalidate installation ที่ไม่มีใน cache ไม่ error", () => {
    const cache = new InstallationTokenCache();
    expect(() => cache.invalidate(99999)).not.toThrow();
  });

  test("invalidateAll ล้าง cache ทั้งหมด", () => {
    const cache = new InstallationTokenCache();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    cache.set(1, "token1", expiresAt);
    cache.set(2, "token2", expiresAt);
    cache.set(3, "token3", expiresAt);

    cache.invalidateAll();
    expect(cache.size()).toBe(0);
    expect(cache.get(1)).toBeNull();
    expect(cache.get(2)).toBeNull();
  });

  test("เก็บ multiple installations แยกกัน", () => {
    const cache = new InstallationTokenCache();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    cache.set(1, "token-for-1", expiresAt);
    cache.set(2, "token-for-2", expiresAt);

    expect(cache.get(1)).toBe("token-for-1");
    expect(cache.get(2)).toBe("token-for-2");
  });

  test("ลบ token ออก cache หลังหมดอายุ (lazy eviction)", () => {
    const cache = new InstallationTokenCache();
    // effective expiry คือ githubExpiresAt - 5 min
    // ตั้งให้ effective หมดแล้วโดยใช้ expiresAt ที่ผ่านไปแล้ว
    const alreadyExpired = new Date(Date.now() - 10 * 60 * 1000); // 10 นาทีที่แล้ว
    cache.set(12345, "expired_token", alreadyExpired);

    expect(cache.get(12345)).toBeNull();
    // lazy eviction: get() ควรลบ entry ออก
    expect(cache.size()).toBe(0);
  });

  test("getEffectiveExpiry คืนเวลาที่ถูกต้อง (สำหรับ assertions ในเทสต์)", () => {
    const cache = new InstallationTokenCache();
    const githubExpiry = new Date(Date.now() + 60 * 60 * 1000);
    cache.set(12345, "token", githubExpiry);

    const effective = cache.getEffectiveExpiry(12345);
    expect(effective).toBeDefined();
    // effective = github - 5min
    expect(effective).toBeCloseTo(githubExpiry.getTime() - 5 * 60 * 1000, -3); // ±1 วินาที
  });
});
