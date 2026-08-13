/**
 * Internal token loader — auth ระหว่าง worker กับ control-api เท่านั้น (Phase 17, terminal)
 *
 * worker ใช้ token นี้ตอนต่อ WebSocket ออกไปหา control-api (Authorization: Bearer <token>)
 * เพื่อยืนยันว่าเป็น worker จริง — ไม่ใช่ browser หรือใครก็ได้ที่เดา session id ถูก
 *
 * หมายเหตุ: duplicated จาก apps/control-api/src/crypto/internal-token.ts โดยตั้งใจ (ADR-0002
 * ห้าม RPC ระหว่าง API กับ worker) — แก้ไฟล์นี้ต้องแก้ไฟล์ duplicate ให้ตรงกันด้วย
 */

import { readFileSync } from "node:fs";

let cached: string | null | undefined;

/** โหลด token จากไฟล์ — cache ไว้ในหน่วยความจำ process เดียวกัน */
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

/** ใช้ในเทสต์ — ล้าง cache เพื่อ mock ค่าใหม่ระหว่าง test suite เดียวกัน */
export function resetInternalTokenCache(): void {
  cached = undefined;
}
