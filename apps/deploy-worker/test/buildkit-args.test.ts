/**
 * buildBuildxArgs unit tests — Phase 8 M1 (untrusted build resource sandboxing)
 * ตรวจ argv ล้วน ๆ โดยไม่ต้องมี Docker daemon จริง (ต่างจาก buildkit.test.ts ที่เป็น integration test)
 */
import { describe, expect, test } from "bun:test";
import { BUILD_SANDBOX_LIMITS } from "@zixploy/shared";
import { buildBuildxArgs } from "../src/docker/buildkit";

function baseParams() {
  return {
    contextDir: "/workspace/ctx",
    dockerfilePath: "Dockerfile",
    tag: "img:tag",
    labels: {},
    timeoutMs: 60_000,
    signal: new AbortController().signal,
    onLog: () => {},
  };
}

describe("buildBuildxArgs — resource sandbox (Phase 8 M1)", () => {
  test("ใส่ --resource memory/cpu-quota/cpu-period จาก BUILD_SANDBOX_LIMITS โดย default", () => {
    const args = buildBuildxArgs(baseParams());

    expect(args).toContain("--resource");
    expect(args).toContain(`memory=${BUILD_SANDBOX_LIMITS.memoryMb}m`);
    expect(args).toContain(`cpu-quota=${BUILD_SANDBOX_LIMITS.cpuQuota}`);
    expect(args).toContain(`cpu-period=${BUILD_SANDBOX_LIMITS.cpuPeriod}`);
  });

  test("ใส่ --ulimit nproc=soft:hard จาก BUILD_SANDBOX_LIMITS โดย default (fork bomb protection)", () => {
    const args = buildBuildxArgs(baseParams());

    expect(args).toContain("--ulimit");
    expect(args).toContain(
      `nproc=${BUILD_SANDBOX_LIMITS.nprocSoft}:${BUILD_SANDBOX_LIMITS.nprocHard}`,
    );
  });

  test("resourceLimits override ใช้ค่าที่ระบุแทน default", () => {
    const args = buildBuildxArgs({
      ...baseParams(),
      resourceLimits: {
        memoryMb: 64,
        cpuQuota: 25_000,
        cpuPeriod: 100_000,
        nprocSoft: 16,
        nprocHard: 16,
      },
    });

    expect(args).toContain("memory=64m");
    expect(args).toContain("cpu-quota=25000");
    expect(args).toContain("nproc=16:16");
    expect(args).not.toContain(`memory=${BUILD_SANDBOX_LIMITS.memoryMb}m`);
  });

  test("ไม่กระทบ flags เดิม (target/build-arg/secret/label/context) ", () => {
    const args = buildBuildxArgs({
      ...baseParams(),
      target: "prod",
      buildArgs: { FOO: "bar" },
      secrets: [{ id: "npmrc", sourcePath: "/tmp/npmrc" }],
      labels: { "platform.managed": "true" },
    });

    expect(args).toContain("--target");
    expect(args).toContain("prod");
    expect(args).toContain("--build-arg");
    expect(args).toContain("FOO=bar");
    expect(args).toContain("--secret");
    expect(args).toContain("id=npmrc,src=/tmp/npmrc");
    expect(args).toContain("--label");
    expect(args).toContain("platform.managed=true");
    expect(args[args.length - 1]).toBe("/workspace/ctx");
  });
});
