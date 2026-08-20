/**
 * isNotFoundError — regression tests ด้วยข้อความจริงจาก Docker CLI
 *
 * ทดสอบแยกจาก docker-cli-client.test.ts โดยตั้งใจ: ไฟล์นั้นต้องมี Docker daemon จริง
 * ส่วนตรรกะ "resource ไม่มีอยู่แล้ว" เป็น string matching ล้วน ทดสอบได้โดยไม่ต้องมี daemon
 *
 * ที่มา (เหตุการณ์จริง 2026-08-20): regex ตกคำว่า "volume" ทำให้ `docker volume rm` บน volume
 * ที่ไม่มีอยู่ไม่ถูกนับว่า idempotent → โยน DOCKER_UNAVAILABLE → reconciler กลืน error เงียบ ๆ
 * → volume ค้าง deletion_pending ตลอดไป เทสต์ชุดนี้กันไม่ให้ resource ชนิดใดตกหล่นอีก
 */

import { describe, expect, test } from "bun:test";
import { isNotFoundError } from "../src/docker/cli-client";

describe("isNotFoundError — ข้อความจริงจาก Docker ทุกชนิด resource", () => {
  // ข้อความต่างกันตามเวอร์ชัน Docker — ครอบทั้งรูปแบบเก่าและใหม่ของแต่ละชนิด
  const notFoundSamples: Array<[string, string]> = [
    ["volume (รูปแบบใหม่)", "Error: No such volume: zxvol-01kztvx-01kzv8q"],
    ["volume (ผ่าน daemon)", "Error response from daemon: remove zxvol-x: no such volume"],
    ["volume (get)", "Error response from daemon: get zxvol-x: no such volume"],
    ["container", "Error: No such container: zx-01kztvx-01m0f78"],
    ["container (ผ่าน daemon)", "Error response from daemon: No such container: abc123"],
    ["image", "Error: No such image: zixploy/proj:tag"],
    ["network", "Error: No such network: zixploy-proxy"],
    ["object", "Error: No such object: something"],
  ];

  for (const [label, stderr] of notFoundSamples) {
    test(`${label} → ถือว่าไม่มีอยู่แล้ว (idempotent)`, () => {
      expect(isNotFoundError(stderr)).toBe(true);
    });
  }

  test("ตัวพิมพ์ใหญ่/เล็กไม่มีผล", () => {
    expect(isNotFoundError("NO SUCH VOLUME: x")).toBe(true);
    expect(isNotFoundError("no such volume: x")).toBe(true);
  });
});

describe("isNotFoundError — error จริงที่ต้องไม่ถูกกลืน", () => {
  const realErrors: Array<[string, string]> = [
    ["volume ถูกใช้อยู่", "Error response from daemon: remove zxvol-x: volume is in use - [abc123]"],
    ["daemon ไม่ทำงาน", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"],
    ["ไม่มีสิทธิ์", "permission denied while trying to connect to the Docker daemon socket"],
    ["disk เต็ม", "Error response from daemon: no space left on device"],
    ["stderr ว่าง", ""],
  ];

  for (const [label, stderr] of realErrors) {
    test(`${label} → ต้อง throw ต่อ (ไม่ใช่ not-found)`, () => {
      expect(isNotFoundError(stderr)).toBe(false);
    });
  }
});
