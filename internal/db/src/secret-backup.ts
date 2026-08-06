import { copyFileSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { restrictPermissions } from "./backup";

/**
 * Backup ไฟล์ secret นอกฐานข้อมูล (master key, Traefik ACME storage) — docs/phase-08-production.md
 * "Backup Scope": encryption keys ต้อง backup แยกช่องทางจาก DB backup เสมอ
 *
 * ผู้เรียกเป็นคนกำหนด destDir แยกจาก DB backup dir — ฟังก์ชันนี้แค่ copy + timestamp + permission
 * ไม่ validate ว่า path ทั้งสองต่างกันจริง (เป็นหน้าที่ operator ตั้ง env var ให้ถูกต้อง)
 */
export function backupSecretFile(
  sourcePath: string,
  destDir: string,
  prefix: string,
  now = Date.now(),
): string {
  mkdirSync(destDir, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const ext = extname(sourcePath);
  const destPath = join(destDir, `${prefix}-${stamp}${ext}`);
  copyFileSync(sourcePath, destPath);
  restrictPermissions(destPath);
  return destPath;
}
