import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupSecretFile } from "../src/secret-backup";

const dirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "zixploy-secret-backup-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("backupSecretFile", () => {
  test("copy ไฟล์ไป destDir พร้อม timestamp ใน filename", () => {
    const srcDir = tempDir();
    const destDir = join(tempDir(), "keys");
    const source = join(srcDir, "master.key");
    writeFileSync(source, "super-secret-key-material");

    const dest = backupSecretFile(
      source,
      destDir,
      "master-key",
      Date.parse("2024-01-02T03:04:05Z"),
    );

    expect(dest.startsWith(destDir)).toBe(true);
    expect(dest).toContain("master-key-2024-01-02");
    expect(readFileSync(dest, "utf8")).toBe("super-secret-key-material");
  });

  test("สร้าง destDir อัตโนมัติถ้ายังไม่มี", () => {
    const srcDir = tempDir();
    const source = join(srcDir, "acme.json");
    writeFileSync(source, "{}");
    const destDir = join(srcDir, "nested", "backup", "acme");

    expect(existsSync(destDir)).toBe(false);
    const dest = backupSecretFile(source, destDir, "acme", Date.now());
    expect(existsSync(dest)).toBe(true);
  });

  test("รักษา extension เดิมของไฟล์ต้นทาง", () => {
    const srcDir = tempDir();
    const source = join(srcDir, "acme.json");
    writeFileSync(source, "{}");
    const dest = backupSecretFile(source, join(srcDir, "out"), "acme", Date.now());
    expect(dest.endsWith(".json")).toBe(true);
  });

  test("ไฟล์ต้นทางไม่มีอยู่จริง → throw", () => {
    const srcDir = tempDir();
    expect(() =>
      backupSecretFile(join(srcDir, "does-not-exist"), join(srcDir, "out"), "x", Date.now()),
    ).toThrow();
  });

  test("บน POSIX จำกัดสิทธิ์ไฟล์ backup เป็น 0600", () => {
    if (process.platform === "win32") return; // restrictPermissions เป็น no-op บน Windows
    const srcDir = tempDir();
    const source = join(srcDir, "master.key");
    writeFileSync(source, "secret");
    const dest = backupSecretFile(source, join(srcDir, "out"), "master-key", Date.now());
    const mode = statSync(dest).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
