/**
 * Prune output parser tests — Phase 11
 *
 * parseReclaimed เป็น pure function จึงเทสต์ได้โดยไม่ต้องมี Docker daemon
 * (ตัวเลขนี้คือสิ่งที่ผู้ใช้เห็นว่า "คืนพื้นที่ได้เท่าไร" — parse ผิดแล้วรายงานโกหก)
 */

import { describe, expect, test } from "bun:test";
import { parseReclaimed } from "../src/maintenance/prune";

describe("parseReclaimed", () => {
  test("อ่านค่าจากบรรทัด Total reclaimed space", () => {
    const out = `Deleted build cache objects:
abc123
def456

Total reclaimed space: 1.234GB
`;
    // docker ใช้ฐาน 1000 สำหรับ GB
    expect(parseReclaimed(out)).toBe(Math.round(1.234 * 1000 ** 3));
  });

  test("หน่วย MB", () => {
    expect(parseReclaimed("Total reclaimed space: 340MB")).toBe(340 * 1000 ** 2);
  });

  test("หน่วย kB", () => {
    expect(parseReclaimed("Total reclaimed space: 12.5kB")).toBe(12500);
  });

  test("หน่วยฐาน 1024 (GiB) ถูกคำนวณต่างจาก GB", () => {
    expect(parseReclaimed("Total reclaimed space: 1GiB")).toBe(1024 ** 3);
    expect(parseReclaimed("Total reclaimed space: 1GB")).toBe(1000 ** 3);
  });

  test("ไม่มีหน่วย → ถือเป็น byte", () => {
    expect(parseReclaimed("Total reclaimed space: 512B")).toBe(512);
    expect(parseReclaimed("Total reclaimed space: 512")).toBe(512);
  });

  test("0B → 0", () => {
    expect(parseReclaimed("Total reclaimed space: 0B")).toBe(0);
  });

  test("ไม่มีบรรทัดนี้เลย (ไม่มีอะไรให้ลบ) → 0", () => {
    expect(parseReclaimed("Nothing to delete\n")).toBe(0);
  });

  test("output ว่าง → 0 ไม่ throw", () => {
    expect(parseReclaimed("")).toBe(0);
  });

  test("ค่าที่ parse ไม่ได้ → 0 (ไม่คืน NaN ให้หลุดลง DB)", () => {
    expect(parseReclaimed("Total reclaimed space: abcGB")).toBe(0);
  });

  test("มีช่องว่างระหว่างตัวเลขกับหน่วย", () => {
    expect(parseReclaimed("Total reclaimed space: 2 MB")).toBe(2 * 1000 ** 2);
  });
});
