/**
 * GitHub App JWT signing (RS256) — ใช้ WebCrypto API ของ Bun ไม่มี external dependency
 *
 * JWT format ตาม GitHub docs:
 *   header: { alg: "RS256", typ: "JWT" }
 *   payload: { iat: now-60, exp: now+600, iss: appId }
 *
 * GitHub ให้อายุสูงสุด 10 นาที; เราใช้ 9 นาทีเพื่อ safety margin
 * iat ถอยหลัง 60 วินาทีเพื่อรับมือ clock skew ของ GitHub
 *
 * docs/threat-model.md: ไม่ log JWT หรือ private key — ห้ามเพิ่ม logging ใน function นี้
 *
 * หมายเหตุ: ไฟล์นี้ duplicated กับ apps/control-api/src/github/jwt.ts โดยตั้งใจ
 * (ADR-0002 ห้าม RPC ระหว่าง API กับ worker — worker ต้อง sign JWT เองเพื่อ mint
 * installation token สำหรับ git clone) — แก้ behavior ที่นี่ต้องแก้ไฟล์ต้นทางให้ตรงกันด้วย
 */

/** JWT อายุสูงสุดที่ GitHub รับ (วินาที) */
export const JWT_MAX_TTL_SECONDS = 9 * 60; // 9 นาที

/** clock skew buffer ที่ GitHub แนะนำ (วินาที) */
const IAT_SKEW_SECONDS = 60;

function base64UrlEncode(value: Uint8Array | string): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  // ArrayBuffer → binary string → base64 → base64url
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * แปลง PEM private key → CryptoKey สำหรับ RS256
 * รองรับ PKCS#8 ("BEGIN PRIVATE KEY") และ PKCS#1 ("BEGIN RSA PRIVATE KEY")
 */
export async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const pemBody = pem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/, "")
    .replace(/\s/g, "");

  let binaryDer: Uint8Array;
  try {
    binaryDer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("GitHub App private key ไม่สามารถ decode base64 ได้ — ตรวจสอบ PEM format");
  }

  // ถ้าเป็น PKCS#1 (BEGIN RSA PRIVATE KEY) ต้อง wrap เป็น PKCS#8
  // GitHub ส่งออก private key เป็น PKCS#1 แต่ WebCrypto ต้องการ PKCS#8
  // PKCS#8 wrapper สำหรับ RSA: ASN.1 sequence ที่มี algorithmIdentifier + key
  const der = isPkcs1(pem) ? wrapPkcs1ToPkcs8(binaryDer) : binaryDer;

  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      der.buffer as ArrayBuffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`GitHub App private key import ล้มเหลว: ${msg}`);
  }
}

function isPkcs1(pem: string): boolean {
  return pem.includes("BEGIN RSA PRIVATE KEY");
}

/**
 * Wrap PKCS#1 RSA key ให้เป็น PKCS#8 format ที่ WebCrypto ยอมรับ
 *
 * PKCS#8 = SEQUENCE {
 *   version INTEGER (0),
 *   algorithm SEQUENCE { rsaEncryption OID, NULL },
 *   privateKey OCTET STRING { <pkcs1 der> }
 * }
 *
 * RSA OID: 1.2.840.113549.1.1.1
 */
function wrapPkcs1ToPkcs8(pkcs1Der: Uint8Array): Uint8Array {
  const algorithmIdentifier = new Uint8Array([
    0x30,
    0x0d, // SEQUENCE, 13 bytes
    0x06,
    0x09, // OID, 9 bytes
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01, // rsaEncryption OID
    0x05,
    0x00, // NULL
  ]);

  // version INTEGER (0)
  const version = new Uint8Array([0x02, 0x01, 0x00]);

  // privateKey OCTET STRING containing pkcs1Der
  const keyOctet = encodeAsn1(0x04, pkcs1Der);

  // inner SEQUENCE
  const inner = concatUint8Arrays(version, algorithmIdentifier, keyOctet);
  const outerSeq = encodeAsn1(0x30, inner);

  return outerSeq;
}

function encodeAsn1(tag: number, content: Uint8Array): Uint8Array {
  const len = content.length;
  let lengthBytes: Uint8Array;
  if (len < 128) {
    lengthBytes = new Uint8Array([len]);
  } else if (len < 256) {
    lengthBytes = new Uint8Array([0x81, len]);
  } else if (len < 65536) {
    lengthBytes = new Uint8Array([0x82, (len >> 8) & 0xff, len & 0xff]);
  } else {
    throw new Error("ASN.1 content too large");
  }
  return concatUint8Arrays(new Uint8Array([tag]), lengthBytes, content);
}

function concatUint8Arrays(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

/**
 * สร้าง GitHub App JWT อายุ ~9 นาที
 *
 * @param appId GitHub App ID (ตัวเลข แต่ส่งเป็น string ใน JWT)
 * @param privateKey CryptoKey ที่ import ไว้แล้ว
 * @param nowSecs Unix timestamp ปัจจุบัน (วินาที) — ฉีดได้เพื่อทดสอบ
 */
export async function signGitHubJwt(
  appId: string,
  privateKey: CryptoKey,
  nowSecs = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iat: nowSecs - IAT_SKEW_SECONDS,
      exp: nowSecs + JWT_MAX_TTL_SECONDS,
      iss: appId,
    }),
  );

  const signingInput = `${header}.${payload}`;
  const data = new TextEncoder().encode(signingInput);
  const rawSig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, data);

  const sig = base64UrlEncode(new Uint8Array(rawSig));
  return `${signingInput}.${sig}`;
}

/** ถอด JWT claims โดยไม่ verify (ใช้สำหรับ introspect เท่านั้น) */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("invalid JWT format");
  const paddedPayload = (parts[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(paddedPayload + "=".repeat((4 - (paddedPayload.length % 4)) % 4));
  return JSON.parse(json) as Record<string, unknown>;
}
