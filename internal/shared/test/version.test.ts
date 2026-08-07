/**
 * Version/semver tests — Phase 12
 *
 * ตัวเทียบเวอร์ชันตัดสินว่าจะขึ้นปุ่ม "Update Available" ไหม — ผิดแล้วชวนผู้ใช้
 * downgrade หรือขึ้นปุ่มค้างทั้งที่อัปเดตแล้ว
 */

import { describe, expect, test } from "bun:test";
import { compareSemVer, hasUpdate, latestStableTag, parseSemVer } from "../src/version";

describe("parseSemVer", () => {
  test("รับทั้งมี v นำหน้าและไม่มี", () => {
    expect(parseSemVer("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemVer("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  test("pre-release", () => {
    expect(parseSemVer("1.0.0-rc.1")).toEqual({ major: 1, minor: 0, patch: 0, pre: "rc.1" });
  });

  test("รูปแบบที่ไม่ใช่ semver → null", () => {
    for (const bad of ["latest", "main", "dev", "1.2", "abc123", "", "1.2.3.4"]) {
      expect(parseSemVer(bad)).toBeNull();
    }
  });
});

describe("compareSemVer", () => {
  const v = (s: string) => parseSemVer(s) as NonNullable<ReturnType<typeof parseSemVer>>;

  test("เทียบ major/minor/patch ตามลำดับ", () => {
    expect(compareSemVer(v("2.0.0"), v("1.9.9"))).toBeGreaterThan(0);
    expect(compareSemVer(v("1.2.0"), v("1.1.9"))).toBeGreaterThan(0);
    expect(compareSemVer(v("1.1.2"), v("1.1.1"))).toBeGreaterThan(0);
  });

  test("เท่ากัน → 0", () => {
    expect(compareSemVer(v("1.2.3"), v("1.2.3"))).toBe(0);
  });

  test("pre-release เก่ากว่า release เลขเดียวกัน (กันชวน downgrade)", () => {
    expect(compareSemVer(v("1.0.0-rc.1"), v("1.0.0"))).toBeLessThan(0);
    expect(compareSemVer(v("1.0.0"), v("1.0.0-rc.1"))).toBeGreaterThan(0);
  });

  test("เทียบ pre-release ด้วยกัน", () => {
    expect(compareSemVer(v("1.0.0-rc.2"), v("1.0.0-rc.1"))).toBeGreaterThan(0);
  });

  test("เลขสองหลักไม่ถูกเทียบแบบ string (0.10.0 ใหม่กว่า 0.9.0)", () => {
    expect(compareSemVer(v("0.10.0"), v("0.9.0"))).toBeGreaterThan(0);
  });
});

describe("latestStableTag", () => {
  test("เลือกตัวใหม่สุด ข้าม tag ที่ไม่ใช่ semver", () => {
    expect(latestStableTag(["latest", "main", "0.1.0", "0.2.0", "sha-abc123"])).toBe("0.2.0");
  });

  test("ข้าม pre-release", () => {
    expect(latestStableTag(["1.0.0", "1.1.0-rc.1"])).toBe("1.0.0");
  });

  test("มีแต่ pre-release → null (ไม่ชวนอัปเดตไปตัวที่ยังไม่นิ่ง)", () => {
    expect(latestStableTag(["1.0.0-rc.1", "1.0.0-beta"])).toBeNull();
  });

  test("รายการว่าง → null", () => {
    expect(latestStableTag([])).toBeNull();
  });

  test("เรียงมาแบบสุ่มก็ยังได้ตัวใหม่สุด", () => {
    expect(latestStableTag(["0.2.0", "0.10.0", "0.9.0"])).toBe("0.10.0");
  });
});

describe("hasUpdate", () => {
  test("มีตัวใหม่กว่า → true", () => {
    expect(hasUpdate("0.1.0", "0.2.0")).toBe(true);
  });

  test("เท่ากันหรือใหม่กว่าอยู่แล้ว → false", () => {
    expect(hasUpdate("0.2.0", "0.2.0")).toBe(false);
    expect(hasUpdate("0.3.0", "0.2.0")).toBe(false);
  });

  test("รันจากซอร์ส (dev) → false เสมอ — ไม่ไปแทน container ให้คนที่ dev อยู่", () => {
    expect(hasUpdate("dev", "9.9.9")).toBe(false);
  });

  test("ตรวจไม่ได้ (latest = null) → false ไม่ใช่ error", () => {
    expect(hasUpdate("0.1.0", null)).toBe(false);
  });

  test("เวอร์ชันปัจจุบันเพี้ยน → false ไม่ throw", () => {
    expect(hasUpdate("garbage", "1.0.0")).toBe(false);
  });
});
