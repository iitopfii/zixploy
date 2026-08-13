/**
 * Internal token loader — auth ระหว่าง control-api กับ worker เท่านั้น (Phase 17, terminal)
 *
 * แยกจาก master key โดยตั้งใจ: master key ใช้เข้ารหัสข้อมูลที่พักในดิสก์ (env vars, password,
 * cert) เปลี่ยนกลางคันแล้วข้อมูลเก่าถอดไม่ได้ ส่วน token นี้เป็นแค่ bearer secret ยืนยันตัวว่า
 * "อีกฝั่งคือ worker จริง" ก่อนให้ต่อ WebSocket relay (services/routes/terminal.ts) — rotate
 * เมื่อไหร่ก็ได้โดยไม่กระทบข้อมูลอะไรเลย ไม่ควรใช้ key ตัวเดียวกันสองหน้าที่
 *
 * อ่านจากไฟล์นอกฐานข้อมูล: ZIXPLOY_INTERNAL_TOKEN_FILE (install.sh สร้างให้อัตโนมัติ
 * เหมือน master.key — ดู deploy/install/install.sh)
 * ไม่ตั้ง env → null (terminal feature ปิด — endpoint คืน 503 ไม่ throw ทั้งระบบ)
 *
 * หมายเหตุ: duplicated ใน apps/deploy-worker/src/internal-token.ts โดยตั้งใจ (ADR-0002
 * ห้าม RPC ระหว่าง API กับ worker) — แก้ไฟล์นี้ต้องแก้ไฟล์ duplicate ให้ตรงกันด้วย
 */

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

let cached: string | null | undefined;

/** โหลด token จากไฟล์ — cache ไว้ในหน่วยความจำ process เดียวกัน (ไม่เปลี่ยนกลางอายุ process) */
export function loadInternalToken(): string | null {
  if (cached !== undefined) return cached;

  const tokenFile = process.env.ZIXPLOY_INTERNAL_TOKEN_FILE;
  if (!tokenFile) {
    cached = null;
    return cached;
  }

  try {
    const content = readFileSync(tokenFile, "utf-8").trim();
    cached = content || null;
  } catch {
    cached = null;
  }
  return cached;
}

/** เทียบแบบ constant-time กัน timing attack เดา token ทีละตัวอักษร */
export function isValidInternalToken(candidate: string | null): boolean {
  const expected = loadInternalToken();
  if (!expected || !candidate) return false;

  const a = Buffer.from(expected, "utf-8");
  const b = Buffer.from(candidate, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** ใช้ในเทสต์ — ล้าง cache เพื่อ mock ค่าใหม่ระหว่าง test suite เดียวกัน */
export function resetInternalTokenCache(): void {
  cached = undefined;
}
