import { describe, expect, test } from "bun:test";
import { isUlid, ulid } from "../src/id";

describe("ulid", () => {
  test("รูปแบบถูกต้อง 26 chars Crockford base32", () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
  });

  test("ไม่ซ้ำและเรียงตามเวลา (monotonic ภายใน ms เดียว)", () => {
    const ids = Array.from({ length: 1000 }, () => ulid());
    expect(new Set(ids).size).toBe(1000);
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  test("isUlid ปฏิเสธค่าที่ไม่ใช่ ULID", () => {
    expect(isUlid("hello")).toBe(false);
    expect(isUlid("")).toBe(false);
    expect(isUlid("I".repeat(26))).toBe(false); // I ไม่อยู่ใน alphabet
  });
});
