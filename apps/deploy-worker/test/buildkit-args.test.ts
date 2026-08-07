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
  // หมายเหตุ: docker buildx build v0.24.0 ไม่รองรับ --memory/--cpu-quota ตรง ๆ
  // (มีเฉพาะ --ulimit และ --shm-size) — memory/CPU limits ต้องตั้งที่ buildkitd daemon แทน
  // ดู: https://docs.docker.com/reference/cli/docker/buildx/build/
  test("ไม่ใช้ --resource (ไม่มีใน buildx) — ใช้ --ulimit เท่านั้นที่ buildx รองรับ", () => {
    const args = buildBuildxArgs(baseParams());

    // buildx ไม่มี --resource flag
    expect(args).not.toContain("--resource");
    // --ulimit สำหรับ nproc (fork bomb protection) ยังอยู่
    expect(args).toContain("--ulimit");
    expect(args).toContain(
      `nproc=${BUILD_SANDBOX_LIMITS.nprocSoft}:${BUILD_SANDBOX_LIMITS.nprocHard}`,
    );
  });

  test("ใส่ --ulimit nproc=soft:hard จาก BUILD_SANDBOX_LIMITS โดย default (fork bomb protection)", () => {
    const args = buildBuildxArgs(baseParams());

    expect(args).toContain("--ulimit");
    expect(args).toContain(
      `nproc=${BUILD_SANDBOX_LIMITS.nprocSoft}:${BUILD_SANDBOX_LIMITS.nprocHard}`,
    );
  });

  test("resourceLimits override ใช้ค่า nproc ที่ระบุแทน default", () => {
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

    // memory/cpu ไม่อยู่ใน args (buildx ไม่รองรับ)
    expect(args).not.toContain("memory=64m");
    expect(args).not.toContain("cpu-quota=25000");
    // nproc ยังใช้ค่าที่ override ได้
    expect(args).toContain("nproc=16:16");
    expect(args).not.toContain(
      `nproc=${BUILD_SANDBOX_LIMITS.nprocSoft}:${BUILD_SANDBOX_LIMITS.nprocHard}`,
    );
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
