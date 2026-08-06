import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Retention สำหรับ backup directory — docs/phase-08-production.md "Backup automation"
 *
 * เก็บไฟล์ล่าสุด `keep` ไฟล์ตาม mtime แล้วลบที่เหลือ — ใช้กับทั้ง DB backup และ secret backup
 * directory เดียวกัน (แยก sub-directory ต่อประเภทไฟล์เพื่อไม่ให้ retention ปนกัน)
 *
 * ไม่มี directory อยู่จริง → ถือว่าไม่มีอะไรต้องลบ (ไม่ throw — backup แรกยังไม่มี dir มาก่อน)
 */
export function pruneOldBackups(dir: string, keep: number): string[] {
  if (keep < 1) throw new Error(`retention count ต้อง >= 1 (ได้ ${keep})`);

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const files = entries
    .map((name) => {
      const path = join(dir, name);
      const stat = statSync(path);
      return { path, mtimeMs: stat.mtimeMs, isFile: stat.isFile() };
    })
    .filter((f) => f.isFile)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const toDelete = files.slice(keep);
  for (const file of toDelete) {
    unlinkSync(file.path);
  }
  return toDelete.map((f) => f.path);
}
