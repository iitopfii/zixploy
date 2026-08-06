/**
 * buildImage integration tests — รันกับ Docker Desktop จริง (docker buildx build)
 * ใช้ alpine เป็น base image (เล็ก, pull เร็ว) เพื่อไม่ให้เทสต์ช้าเกินไป
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@zixploy/shared";
import { buildImage } from "../src/docker/buildkit";

const dirs: string[] = [];
const builtTags: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "zixploy-buildkit-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows อาจปล่อย handle ช้า
    }
  }
});

afterAll(async () => {
  for (const tag of builtTags) {
    const proc = Bun.spawn(["docker", "rmi", "-f", tag], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  }
});

function trackTag(tag: string): string {
  builtTags.push(tag);
  return tag;
}

describe("buildImage — success", () => {
  test("build image จาก Dockerfile ปกติสำเร็จ — คืน imageId + digest", async () => {
    const ctx = tempDir();
    writeFileSync(join(ctx, "Dockerfile"), 'FROM alpine:latest\nCMD ["echo", "hello"]\n');

    const tag = trackTag(`zx-buildkit-test-${Date.now()}:latest`);
    const logs: string[] = [];

    const result = await buildImage({
      contextDir: ctx,
      dockerfilePath: "Dockerfile",
      tag,
      labels: { "platform.managed": "true" },
      timeoutMs: 120_000,
      signal: new AbortController().signal,
      onLog: (line) => logs.push(line),
    });

    expect(result.imageId).toMatch(/^sha256:/);
    // RepoDigests format คือ "<repo>@sha256:..." ถ้ามี, หรือ fallback เป็น imageId (bare "sha256:...")
    expect(result.digest).toContain("sha256:");
    expect(logs.length).toBeGreaterThan(0);
  }, 60_000);

  test("build args ถูกส่งเข้า build จริง (ARG ปรากฏใน image label ที่เราตั้งเอง)", async () => {
    const ctx = tempDir();
    writeFileSync(
      join(ctx, "Dockerfile"),
      'FROM alpine:latest\nARG GREETING=default\nENV GREETING=$GREETING\nCMD ["sh", "-c", "echo $GREETING"]\n',
    );

    const tag = trackTag(`zx-buildkit-buildarg-${Date.now()}:latest`);
    await buildImage({
      contextDir: ctx,
      dockerfilePath: "Dockerfile",
      tag,
      buildArgs: { GREETING: "hello-from-buildarg" },
      labels: {},
      timeoutMs: 120_000,
      signal: new AbortController().signal,
      onLog: () => {},
    });

    // ตรวจว่า build args ถูกใช้จริง — run container แล้วดู output
    const runProc = Bun.spawn(["docker", "run", "--rm", tag], { stdout: "pipe", stderr: "pipe" });
    const output = (await new Response(runProc.stdout).text()).trim();
    await runProc.exited;
    expect(output).toBe("hello-from-buildarg");
  }, 60_000);
});

describe("buildImage — failure cases", () => {
  test("Dockerfile ไม่มีอยู่จริง → AppError DOCKERFILE_NOT_FOUND", async () => {
    const ctx = tempDir();
    const tag = `zx-buildkit-nofile-${Date.now()}:latest`;

    let caught: unknown;
    try {
      await buildImage({
        contextDir: ctx,
        dockerfilePath: "Dockerfile.does-not-exist",
        tag,
        labels: {},
        timeoutMs: 30_000,
        signal: new AbortController().signal,
        onLog: () => {},
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("DOCKERFILE_NOT_FOUND");
  }, 30_000);

  test("Dockerfile ที่มี RUN ล้มเหลว → AppError BUILD_FAILED", async () => {
    const ctx = tempDir();
    writeFileSync(join(ctx, "Dockerfile"), "FROM alpine:latest\nRUN exit 1\n");
    const tag = `zx-buildkit-runfail-${Date.now()}:latest`;

    let caught: unknown;
    try {
      await buildImage({
        contextDir: ctx,
        dockerfilePath: "Dockerfile",
        tag,
        labels: {},
        timeoutMs: 60_000,
        signal: new AbortController().signal,
        onLog: () => {},
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("BUILD_FAILED");
  }, 60_000);

  test("timeout สั้นเกินไป → AppError BUILD_TIMEOUT", async () => {
    const ctx = tempDir();
    // เนื้อหา RUN ต้อง unique ทุกครั้ง — ไม่งั้น BuildKit cache layer เดิมแล้ว sleep ไม่เกิดจริง
    writeFileSync(
      join(ctx, "Dockerfile"),
      `FROM alpine:latest\nRUN sleep 30 && echo cache-bust-${Date.now()}\n`,
    );
    const tag = `zx-buildkit-timeout-${Date.now()}:latest`;

    let caught: unknown;
    try {
      await buildImage({
        contextDir: ctx,
        dockerfilePath: "Dockerfile",
        tag,
        labels: {},
        timeoutMs: 2_000,
        signal: new AbortController().signal,
        onLog: () => {},
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("BUILD_TIMEOUT");
  }, 30_000);

  test("external signal abort (ไม่ใช่ timeout ของตัวเอง) → ล้มเหลวแต่ไม่ค้าง", async () => {
    const ctx = tempDir();
    writeFileSync(
      join(ctx, "Dockerfile"),
      `FROM alpine:latest\nRUN sleep 30 && echo cache-bust-${Date.now()}\n`,
    );
    const tag = `zx-buildkit-extcancel-${Date.now()}:latest`;
    const controller = new AbortController();

    const buildPromise = buildImage({
      contextDir: ctx,
      dockerfilePath: "Dockerfile",
      tag,
      labels: {},
      timeoutMs: 60_000, // timeout ยาว — ไม่ใช่สาเหตุ
      signal: controller.signal,
      onLog: () => {},
    });

    setTimeout(() => controller.abort(), 1_000);

    let caught: unknown;
    try {
      await buildPromise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    // ไม่ใช่ BUILD_TIMEOUT เพราะ timeout ของตัวเองยาวมาก — สาเหตุคือ external cancel
    expect((caught as AppError).code).not.toBe("BUILD_TIMEOUT");
  }, 20_000);
});
