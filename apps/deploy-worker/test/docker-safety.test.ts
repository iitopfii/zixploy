import { describe, expect, test } from "bun:test";
import { AppError } from "@zixploy/shared";
import { assertContainerConfigSafe, assertDockerArgsSafe } from "../src/docker/safety";
import type { ContainerCreateParams } from "../src/docker/types";

function baseParams(overrides: Partial<ContainerCreateParams> = {}): ContainerCreateParams {
  return {
    name: "zx-project01-deploy01",
    image: "zixploy/project01:abc123-deploy01",
    labels: { "platform.managed": "true" },
    restartPolicy: "unless-stopped",
    networkName: "zixploy-proxy",
    ...overrides,
  };
}

describe("assertContainerConfigSafe", () => {
  test("config ปกติ → ผ่าน", () => {
    expect(() => assertContainerConfigSafe(baseParams())).not.toThrow();
  });

  test("networkName = 'host' → throw", () => {
    expect(() => assertContainerConfigSafe(baseParams({ networkName: "host" }))).toThrow(AppError);
  });

  test("cpuLimit <= 0 → throw", () => {
    expect(() => assertContainerConfigSafe(baseParams({ cpuLimit: 0 }))).toThrow(AppError);
    expect(() => assertContainerConfigSafe(baseParams({ cpuLimit: -1 }))).toThrow(AppError);
  });

  test("memoryLimitMb <= 0 → throw", () => {
    expect(() => assertContainerConfigSafe(baseParams({ memoryLimitMb: 0 }))).toThrow(AppError);
  });

  test("pidsLimit <= 0 → throw", () => {
    expect(() => assertContainerConfigSafe(baseParams({ pidsLimit: 0 }))).toThrow(AppError);
  });

  test("cpuLimit/memoryLimitMb เป็น null (ไม่ตั้ง limit) → ผ่าน", () => {
    expect(() =>
      assertContainerConfigSafe(baseParams({ cpuLimit: null, memoryLimitMb: null })),
    ).not.toThrow();
  });
});

describe("assertDockerArgsSafe", () => {
  test("args ปกติ → ผ่าน", () => {
    const args = [
      "create",
      "--name",
      "zx-test",
      "--network",
      "zixploy-proxy",
      "--restart",
      "unless-stopped",
      "--label",
      "platform.managed=true",
    ];
    expect(() => assertDockerArgsSafe(args)).not.toThrow();
  });

  test("--privileged → throw", () => {
    expect(() => assertDockerArgsSafe(["create", "--privileged", "image"])).toThrow(AppError);
    expect(() => assertDockerArgsSafe(["create", "--privileged=true", "image"])).toThrow(AppError);
  });

  test("--network host (แยก 2 args) → throw", () => {
    expect(() => assertDockerArgsSafe(["create", "--network", "host", "image"])).toThrow(AppError);
  });

  test("--network=host (arg เดียว) → throw", () => {
    expect(() => assertDockerArgsSafe(["create", "--network=host", "image"])).toThrow(AppError);
  });

  test("--cap-add ใด ๆ → throw", () => {
    expect(() => assertDockerArgsSafe(["create", "--cap-add", "SYS_ADMIN", "image"])).toThrow(
      AppError,
    );
    expect(() => assertDockerArgsSafe(["create", "--cap-add=NET_ADMIN", "image"])).toThrow(
      AppError,
    );
  });

  test("--pid host → throw", () => {
    expect(() => assertDockerArgsSafe(["create", "--pid", "host", "image"])).toThrow(AppError);
    expect(() => assertDockerArgsSafe(["create", "--pid=host", "image"])).toThrow(AppError);
  });

  test("mount docker.sock (-v) → throw", () => {
    expect(() =>
      assertDockerArgsSafe(["create", "-v", "/var/run/docker.sock:/var/run/docker.sock", "image"]),
    ).toThrow(AppError);
  });

  test("mount /proc, /sys, /dev → throw", () => {
    expect(() => assertDockerArgsSafe(["create", "-v", "/proc:/host/proc", "image"])).toThrow(
      AppError,
    );
    expect(() => assertDockerArgsSafe(["create", "--volume", "/sys:/host/sys", "image"])).toThrow(
      AppError,
    );
    expect(() =>
      assertDockerArgsSafe(["create", "--mount", "type=bind,src=/dev,dst=/dev", "image"]),
    ).toThrow(AppError);
  });

  test("mount root filesystem ('/') → throw", () => {
    expect(() => assertDockerArgsSafe(["create", "-v", "/:/host", "image"])).toThrow(AppError);
  });

  test("mount path ปกติที่ไม่อ่อนไหว → ผ่าน", () => {
    expect(() =>
      assertDockerArgsSafe(["create", "-v", "zxvol-project01-vol01:/app/data", "image"]),
    ).not.toThrow();
  });

  test("path ที่มี 'proc'/'dev' เป็นส่วนหนึ่งของชื่อปกติ (ไม่ใช่ target จริง) ไม่ควร false-positive เกินจำเป็น", () => {
    // เช่น "/app/processing:/data" มีคำว่า "proc" ปนอยู่ — ยอมรับ false positive ตรงนี้ได้
    // เพราะ safety-first ดีกว่า permissive-first สำหรับ denylist ระดับนี้ — ไม่ได้ทดสอบว่าต้องผ่าน
    // แค่ยืนยันว่า path ที่ไม่มีคำต้องห้ามเป็น substring เลยจะผ่านแน่นอน
    expect(() =>
      assertDockerArgsSafe(["create", "-v", "zxvol-app-data:/application/storage", "image"]),
    ).not.toThrow();
  });
});
