import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneOldBackups } from "../src/retention";

const dirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "zixploy-retention-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** สร้างไฟล์พร้อมตั้ง mtime เอง — ให้ควบคุม "อายุ" ของไฟล์ได้แน่นอนในเทสต์ */
function makeFile(dir: string, name: string, mtimeMs: number): string {
  const path = join(dir, name);
  writeFileSync(path, "x");
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

describe("pruneOldBackups", () => {
  test("directory ยังไม่มีอยู่ → คืน [] ไม่ throw", () => {
    const dir = join(tmpdir(), "zixploy-retention-does-not-exist");
    expect(pruneOldBackups(dir, 5)).toEqual([]);
  });

  test("จำนวนไฟล์น้อยกว่า keep → ไม่ลบอะไรเลย", () => {
    const dir = tempDir();
    makeFile(dir, "a", 1000);
    makeFile(dir, "b", 2000);
    const deleted = pruneOldBackups(dir, 5);
    expect(deleted).toEqual([]);
    expect(existsSync(join(dir, "a"))).toBe(true);
    expect(existsSync(join(dir, "b"))).toBe(true);
  });

  test("เก็บไฟล์ล่าสุด keep ไฟล์ ลบที่เหลือ (เรียงตาม mtime)", () => {
    const dir = tempDir();
    makeFile(dir, "oldest", 1000);
    makeFile(dir, "middle", 2000);
    makeFile(dir, "newest", 3000);

    const deleted = pruneOldBackups(dir, 2);
    expect(deleted).toEqual([join(dir, "oldest")]);
    expect(existsSync(join(dir, "oldest"))).toBe(false);
    expect(existsSync(join(dir, "middle"))).toBe(true);
    expect(existsSync(join(dir, "newest"))).toBe(true);
  });

  test("keep = 0 หรือติดลบ → throw (ป้องกัน retention ลบทุกไฟล์โดยไม่ตั้งใจ)", () => {
    const dir = tempDir();
    expect(() => pruneOldBackups(dir, 0)).toThrow();
    expect(() => pruneOldBackups(dir, -1)).toThrow();
  });

  test("ไม่แตะ sub-directory — ลบเฉพาะไฟล์", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "nested"));
    makeFile(dir, "a", 1000);
    const deleted = pruneOldBackups(dir, 1);
    expect(deleted).toEqual([]);
    expect(existsSync(join(dir, "nested"))).toBe(true);
  });
});
