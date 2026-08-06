/**
 * isDiskFullError — unit test ล้วน ๆ ด้วย stderr จำลอง เพราะการจำลอง ENOSPC จริงต้องเติมดิสก์
 * เต็มจริง (ไม่ทำในเทสต์อัตโนมัติ) ข้อความอ้างอิงจาก git/docker error message รูปแบบจริงที่พบทั่วไป
 */
import { describe, expect, test } from "bun:test";
import { isDiskFullError } from "../src/disk-full";

describe("isDiskFullError", () => {
  test("git error ที่มี 'No space left on device' → true", () => {
    expect(
      isDiskFullError(
        "error: unable to write file .git/objects/pack/tmp_pack: No space left on device",
      ),
    ).toBe(true);
  });

  test("docker/buildkit error ที่มี 'no space left on device' (ตัวพิมพ์เล็ก) → true", () => {
    expect(
      isDiskFullError("failed to solve: write /var/lib/docker/tmp/x: no space left on device"),
    ).toBe(true);
  });

  test("stderr มีคำว่า ENOSPC ตรง ๆ → true", () => {
    expect(isDiskFullError("Error: ENOSPC: no space left on device, write")).toBe(true);
  });

  test("error อื่นที่ไม่เกี่ยวกับดิสก์ (auth ล้มเหลว) → false", () => {
    expect(isDiskFullError("fatal: Authentication failed for 'https://github.com/...'")).toBe(
      false,
    );
  });

  test("error อื่นที่ไม่เกี่ยวกับดิสก์ (Dockerfile หาย) → false", () => {
    expect(
      isDiskFullError("failed to read dockerfile: open Dockerfile: no such file or directory"),
    ).toBe(false);
  });

  test("string ว่างเปล่า → false", () => {
    expect(isDiskFullError("")).toBe(false);
  });
});
