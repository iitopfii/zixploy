import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@zixploy/shared";
import {
  assertDockerfileWithinContext,
  assertSafeRelativePath,
  assertWorkspaceSizeWithinLimit,
  createWorkspace,
  removeWorkspace,
  workspacesDir,
} from "../src/workspace";

const dirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "zixploy-workspace-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows อาจปล่อย handle ช้า — ปล่อยให้ OS เก็บกวาด
    }
  }
});

describe("assertSafeRelativePath", () => {
  test("path ปกติ ('.', 'sub/dir') → ผ่าน", () => {
    expect(() => assertSafeRelativePath(".", "buildContext")).not.toThrow();
    expect(() => assertSafeRelativePath("sub/dir", "buildContext")).not.toThrow();
  });

  test("absolute path (unix) → throw WORKSPACE_ERROR", () => {
    let caught: unknown;
    try {
      assertSafeRelativePath("/etc/passwd", "buildContext");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("WORKSPACE_ERROR");
  });

  test("absolute path (windows drive letter) → throw", () => {
    expect(() => assertSafeRelativePath("C:\\Windows\\System32", "buildContext")).toThrow(AppError);
  });

  test("path มี '..' → throw", () => {
    expect(() => assertSafeRelativePath("../../etc/passwd", "buildContext")).toThrow(AppError);
    expect(() => assertSafeRelativePath("sub/../../escape", "buildContext")).toThrow(AppError);
  });

  test("'..' อยู่กลาง segment ปกติ (เช่น 'foo..bar') → ไม่ throw (ไม่ใช่ '..' segment เดี่ยว ๆ)", () => {
    expect(() => assertSafeRelativePath("foo..bar/baz", "buildContext")).not.toThrow();
  });
});

describe("createWorkspace / removeWorkspace", () => {
  // ชี้ ZIXPLOY_WORKSPACES_DIR ไปที่ temp dir — ไม่งั้น workspacesDir() default จะเขียนลง
  // <repo>/data/workspaces จริง ๆ ระหว่างรันเทสต์
  const testWorkspacesRoot = tempDir();
  process.env.ZIXPLOY_WORKSPACES_DIR = testWorkspacesRoot;

  test("สร้าง workspace directory จริงและคืน path ที่ถูกต้อง", () => {
    const deploymentId = "01JTESTDEPLOY0000000000001";
    const { workspaceDir, buildContextDir } = createWorkspace(deploymentId, ".");

    expect(workspaceDir).toBe(join(workspacesDir(), deploymentId));
    expect(existsSync(workspaceDir)).toBe(true);
    expect(buildContextDir).toBe(join(workspaceDir, "."));

    removeWorkspace(deploymentId);
    expect(existsSync(workspaceDir)).toBe(false);
  });

  test("เรียกซ้ำ (idempotent retry) → ลบของเก่าทิ้งก่อนสร้างใหม่เสมอ", () => {
    const deploymentId = "01JTESTDEPLOY0000000000002";
    const first = createWorkspace(deploymentId, ".");
    writeFileSync(join(first.workspaceDir, "stale-file.txt"), "leftover from crashed attempt");
    expect(existsSync(join(first.workspaceDir, "stale-file.txt"))).toBe(true);

    const second = createWorkspace(deploymentId, ".");
    expect(existsSync(join(second.workspaceDir, "stale-file.txt"))).toBe(false);

    removeWorkspace(deploymentId);
  });

  test("buildContext ที่ไม่ปลอดภัย → throw ก่อนสร้าง directory ใด ๆ", () => {
    const deploymentId = "01JTESTDEPLOY0000000000003";
    expect(() => createWorkspace(deploymentId, "../escape")).toThrow(AppError);
  });
});

describe("assertDockerfileWithinContext", () => {
  test("Dockerfile อยู่ใน context ปกติ → ผ่าน", () => {
    const ctx = tempDir();
    writeFileSync(join(ctx, "Dockerfile"), "FROM scratch");
    expect(() => assertDockerfileWithinContext(ctx, "Dockerfile")).not.toThrow();
  });

  test("Dockerfile อยู่ใน subdirectory ของ context → ผ่าน", () => {
    const ctx = tempDir();
    mkdirSync(join(ctx, "docker"), { recursive: true });
    writeFileSync(join(ctx, "docker", "Dockerfile"), "FROM scratch");
    expect(() => assertDockerfileWithinContext(ctx, "docker/Dockerfile")).not.toThrow();
  });

  test("ไม่มี Dockerfile จริง → throw DOCKERFILE_NOT_FOUND", () => {
    const ctx = tempDir();
    let caught: unknown;
    try {
      assertDockerfileWithinContext(ctx, "Dockerfile");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("DOCKERFILE_NOT_FOUND");
  });

  test("build context เองไม่มีอยู่จริง → throw DOCKERFILE_NOT_FOUND", () => {
    expect(() =>
      assertDockerfileWithinContext(join(tmpdir(), "zixploy-nonexistent-ctx"), "Dockerfile"),
    ).toThrow(AppError);
  });

  test("dockerfilePath มี '..' (string-level) → throw ก่อนแตะ filesystem", () => {
    const ctx = tempDir();
    expect(() => assertDockerfileWithinContext(ctx, "../Dockerfile")).toThrow(AppError);
  });

  test("symlink escape: Dockerfile เป็น symlink ชี้ออกนอก context → throw", () => {
    // Windows ต้องมีสิทธิ์ elevated ถึงสร้าง symlink ได้ปกติ — skip ถ้าสร้างไม่ได้แทนที่จะ fail
    const ctx = tempDir();
    const outsideDir = tempDir();
    const secretFile = join(outsideDir, "secret-outside-context.txt");
    writeFileSync(secretFile, "should not be reachable");

    const symlinkPath = join(ctx, "Dockerfile");
    try {
      symlinkSync(secretFile, symlinkPath, "file");
    } catch {
      // ไม่มีสิทธิ์สร้าง symlink บนเครื่องนี้ (พบได้บน Windows ที่ไม่ใช่ admin/no developer mode)
      console.warn("skip: ไม่มีสิทธิ์สร้าง symlink บนเครื่องนี้");
      return;
    }

    let caught: unknown;
    try {
      assertDockerfileWithinContext(ctx, "Dockerfile");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("DOCKERFILE_NOT_FOUND");
  });
});

describe("assertWorkspaceSizeWithinLimit", () => {
  test("workspace เล็กกว่า limit → ผ่าน", () => {
    const ctx = tempDir();
    writeFileSync(join(ctx, "small.txt"), "a".repeat(1024)); // 1KB
    expect(() => assertWorkspaceSizeWithinLimit(ctx, 1)).not.toThrow();
  });

  test("workspace ใหญ่กว่า limit → throw WORKSPACE_TOO_LARGE", () => {
    const ctx = tempDir();
    writeFileSync(join(ctx, "big.bin"), Buffer.alloc(2 * 1024 * 1024)); // 2MB
    let caught: unknown;
    try {
      assertWorkspaceSizeWithinLimit(ctx, 1); // limit 1MB
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("WORKSPACE_TOO_LARGE");
  });

  test("รวมขนาดไฟล์ใน subdirectory ด้วย (recursive)", () => {
    const ctx = tempDir();
    mkdirSync(join(ctx, "sub"), { recursive: true });
    writeFileSync(join(ctx, "a.bin"), Buffer.alloc(1024 * 1024)); // 1MB
    writeFileSync(join(ctx, "sub", "b.bin"), Buffer.alloc(1024 * 1024)); // 1MB
    expect(() => assertWorkspaceSizeWithinLimit(ctx, 1)).toThrow(AppError); // รวม 2MB > 1MB
    expect(() => assertWorkspaceSizeWithinLimit(ctx, 3)).not.toThrow();
  });
});
