/**
 * Master key loader — docs/encryption.md
 *
 * อ่านจากไฟล์นอกฐานข้อมูล: ZIXPLOY_MASTER_KEY_FILE
 * รองรับ 2 format:
 * 1. JSON: { "active": 2, "keys": { "1": "<base64>", "2": "<base64>" } } — รองรับ rotation
 * 2. Plain base64 32-byte เดี่ยว — ถือเป็น key id 1
 *
 * ห้าม log ค่า key ทุกกรณี รวม debug mode
 * ไม่มีไฟล์/ไฟล์ผิด format → คืน null (GitHub App features ปิด, worker claim job อื่นได้ตามปกติ)
 *
 * หมายเหตุ: ไฟล์นี้ duplicated กับ apps/control-api/src/crypto/master-key.ts โดยตั้งใจ
 * (ADR-0002 ห้าม RPC ระหว่าง API กับ worker — worker ต้อง decrypt เองจาก DB โดยตรง
 * ไม่ผ่าน control-api) — แก้ behavior ที่นี่ต้องแก้ไฟล์ต้นทางให้ตรงกันด้วย
 */

import { readFileSync } from "node:fs";

export interface MasterKeys {
  /** key id ที่ใช้เข้ารหัสค่าใหม่ */
  active: number;
  /** key id → AES-256-GCM CryptoKey (import แล้ว) */
  keys: Map<number, CryptoKey>;
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) {
    throw new Error(`master key ต้องยาว 32 bytes (ได้ ${raw.length})`);
  }
  return crypto.subtle.importKey("raw", raw.buffer as ArrayBuffer, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.trim(), "base64"));
}

/** สร้าง MasterKeys จาก raw bytes — ใช้ในเทสต์ */
export async function createMasterKeys(
  active: number,
  rawKeys: Record<number, Uint8Array>,
): Promise<MasterKeys> {
  const keys = new Map<number, CryptoKey>();
  for (const [id, raw] of Object.entries(rawKeys)) {
    keys.set(Number(id), await importAesKey(raw));
  }
  if (!keys.has(active)) {
    throw new Error(`active key id ${active} ไม่มีในชุด keys`);
  }
  return { active, keys };
}

/**
 * โหลด master keys จากไฟล์ที่ ZIXPLOY_MASTER_KEY_FILE ชี้
 * ไม่ตั้ง env → null (ไม่ error — build job ที่ต้องใช้ token จะ fail แยกจากกัน)
 * ตั้ง env แต่ไฟล์ผิด → throw (fail closed — ไม่เปิด service แบบ encryption ครึ่งเดียว)
 */
export async function loadMasterKeys(): Promise<MasterKeys | null> {
  const keyFile = process.env.ZIXPLOY_MASTER_KEY_FILE;
  if (!keyFile) return null;

  let content: string;
  try {
    content = readFileSync(keyFile, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`อ่าน master key file ไม่ได้จาก ${keyFile}: ${msg}`);
  }

  // format 1: JSON with rotation support
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    let parsed: { active?: unknown; keys?: unknown };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("master key file ไม่ใช่ JSON ที่ถูกต้อง");
    }
    const active = Number(parsed.active);
    if (!Number.isInteger(active) || active < 1 || active > 255) {
      throw new Error("master key file: active ต้องเป็น integer 1-255");
    }
    if (!parsed.keys || typeof parsed.keys !== "object") {
      throw new Error("master key file: ขาด keys object");
    }
    const rawKeys: Record<number, Uint8Array> = {};
    for (const [id, b64] of Object.entries(parsed.keys as Record<string, unknown>)) {
      const keyId = Number(id);
      if (!Number.isInteger(keyId) || keyId < 1 || keyId > 255) {
        throw new Error(`master key file: key id "${id}" ต้องเป็น integer 1-255`);
      }
      if (typeof b64 !== "string") {
        throw new Error(`master key file: key "${id}" ต้องเป็น base64 string`);
      }
      rawKeys[keyId] = decodeBase64(b64);
    }
    return createMasterKeys(active, rawKeys);
  }

  // format 2: plain base64 single key = id 1
  return createMasterKeys(1, { 1: decodeBase64(trimmed) });
}
