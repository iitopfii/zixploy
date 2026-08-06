/**
 * Volume validation tests — Phase 7 M2
 *
 * ครอบคลุม:
 * - validateMountPath() ใน @zixploy/shared: valid/invalid paths
 * - assertDockerArgsSafe() กับ --mount type=volume,...: sensitive paths ถูก reject
 * - assertContainerConfigSafe() กับ volumes param: ตรวจ mountPath ก่อน spawn
 */

import { describe, expect, test } from "bun:test";
import { AppError, validateMountPath } from "@zixploy/shared";
import { assertContainerConfigSafe, assertDockerArgsSafe } from "../src/docker/safety";
import type { ContainerCreateParams } from "../src/docker/types";

// ---------------------------------------------------------------------------
// validateMountPath
// ---------------------------------------------------------------------------

describe("validateMountPath", () => {
  // --- valid paths ---
  test("/app/data → ok", () => {
    expect(validateMountPath("/app/data")).toEqual({ ok: true });
  });

  test("/data → ok", () => {
    expect(validateMountPath("/data")).toEqual({ ok: true });
  });

  test("/var/www → ok (ไม่ใช่ /var/run/docker.sock)", () => {
    expect(validateMountPath("/var/www")).toEqual({ ok: true });
  });

  test("/usr/local/share → ok (ไม่ใช่ /usr/bin)", () => {
    expect(validateMountPath("/usr/local/share")).toEqual({ ok: true });
  });

  test("/mnt/storage → ok", () => {
    expect(validateMountPath("/mnt/storage")).toEqual({ ok: true });
  });

  // --- invalid: not absolute ---
  test("relative path → fail", () => {
    const r = validateMountPath("app/data");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("absolute");
  });

  test("empty string → fail", () => {
    expect(validateMountPath("")).toMatchObject({ ok: false });
  });

  // --- invalid: root ---
  test("/ → fail (root filesystem)", () => {
    const r = validateMountPath("/");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("root");
  });

  // --- invalid: path traversal ---
  test("/app/../etc → fail (contains ..)", () => {
    const r = validateMountPath("/app/../etc");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("..");
  });

  // --- invalid: sensitive paths ---
  test("/proc → fail", () => {
    expect(validateMountPath("/proc")).toMatchObject({ ok: false });
  });

  test("/proc/cpuinfo → fail (sub-path of /proc)", () => {
    expect(validateMountPath("/proc/cpuinfo")).toMatchObject({ ok: false });
  });

  test("/sys → fail", () => {
    expect(validateMountPath("/sys")).toMatchObject({ ok: false });
  });

  test("/dev → fail", () => {
    expect(validateMountPath("/dev")).toMatchObject({ ok: false });
  });

  test("/dev/null → fail (sub-path of /dev)", () => {
    expect(validateMountPath("/dev/null")).toMatchObject({ ok: false });
  });

  test("/etc → fail", () => {
    expect(validateMountPath("/etc")).toMatchObject({ ok: false });
  });

  test("/etc/passwd → fail (sub-path of /etc)", () => {
    expect(validateMountPath("/etc/passwd")).toMatchObject({ ok: false });
  });

  test("/var/run/docker.sock → fail", () => {
    expect(validateMountPath("/var/run/docker.sock")).toMatchObject({ ok: false });
  });

  test("/.dockerenv → fail", () => {
    expect(validateMountPath("/.dockerenv")).toMatchObject({ ok: false });
  });

  test("/bin → fail", () => {
    expect(validateMountPath("/bin")).toMatchObject({ ok: false });
  });

  test("/usr/bin → fail", () => {
    expect(validateMountPath("/usr/bin")).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// assertDockerArgsSafe with --mount type=volume format
// ---------------------------------------------------------------------------

describe("assertDockerArgsSafe — volume mounts", () => {
  function safeArgs(mountSpec: string): string[] {
    return ["create", "--name", "ctr", "--network", "zixploy-proxy", "--mount", mountSpec];
  }

  test("valid named volume mount ไม่ throw", () => {
    expect(() =>
      assertDockerArgsSafe(safeArgs("type=volume,source=zxvol-abc,target=/app/data")),
    ).not.toThrow();
  });

  test("readonly named volume ไม่ throw", () => {
    expect(() =>
      assertDockerArgsSafe(safeArgs("type=volume,source=zxvol-abc,target=/app/data,readonly")),
    ).not.toThrow();
  });

  test("sensitive target /proc throw", () => {
    expect(() =>
      assertDockerArgsSafe(safeArgs("type=volume,source=zxvol-abc,target=/proc")),
    ).toThrow(AppError);
  });

  test("sensitive target /var/run/docker.sock throw", () => {
    expect(() =>
      assertDockerArgsSafe(safeArgs("type=volume,source=zxvol-abc,target=/var/run/docker.sock")),
    ).toThrow(AppError);
  });

  test("root target / throw", () => {
    expect(() => assertDockerArgsSafe(safeArgs("type=volume,source=zxvol-abc,target=/"))).toThrow(
      AppError,
    );
  });
});

// ---------------------------------------------------------------------------
// assertContainerConfigSafe — ตรวจ volume mountPaths ใน params
// ---------------------------------------------------------------------------

describe("assertContainerConfigSafe — volumes param", () => {
  function baseParams(overrides: Partial<ContainerCreateParams> = {}): ContainerCreateParams {
    return {
      name: "ctr",
      image: "img",
      labels: {},
      restartPolicy: "unless-stopped",
      networkName: "zixploy-proxy",
      ...overrides,
    };
  }

  test("valid volume mount path ไม่ throw", () => {
    expect(() =>
      assertContainerConfigSafe(
        baseParams({ volumes: [{ dockerName: "zxvol-x", mountPath: "/app/data" }] }),
      ),
    ).not.toThrow();
  });

  test("sensitive volume mount path throw VOLUME_INVALID_PATH", () => {
    expect(() =>
      assertContainerConfigSafe(
        baseParams({ volumes: [{ dockerName: "zxvol-x", mountPath: "/proc" }] }),
      ),
    ).toThrow(AppError);
  });

  test("relative mount path throw", () => {
    expect(() =>
      assertContainerConfigSafe(
        baseParams({ volumes: [{ dockerName: "zxvol-x", mountPath: "relative/path" }] }),
      ),
    ).toThrow(AppError);
  });

  test("no volumes param ไม่ throw", () => {
    expect(() => assertContainerConfigSafe(baseParams())).not.toThrow();
  });

  test("empty volumes array ไม่ throw", () => {
    expect(() => assertContainerConfigSafe(baseParams({ volumes: [] }))).not.toThrow();
  });
});
