/**
 * AES-256-GCM encryption envelope — docs/encryption.md
 *
 * Format (binary):
 *   [1 byte  version]    = 0x01
 *   [1 byte  key_id]     master key version ที่ใช้เข้ารหัส
 *   [12 byte nonce]      สุ่มใหม่ทุกครั้ง — ห้าม reuse
 *   [N byte  ciphertext + 16 byte GCM tag]
 *
 * AAD ผูก ciphertext กับ context (เช่น "github_app:<id>:pem")
 * — ย้าย ciphertext ข้าม row/field แล้ว decrypt ไม่ได้
 */

import type { MasterKeys } from "./master-key";

const ENVELOPE_VERSION = 0x01;
const NONCE_BYTES = 12;
const HEADER_BYTES = 2 + NONCE_BYTES; // version + key_id + nonce

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * แปลง Uint8Array เป็น ArrayBuffer ที่ตรงกับ view เท่านั้น
 * ใช้ .buffer ตรงๆ ไม่ปลอดภัยเมื่อ view เป็น subarray ของ buffer ที่ใหญ่กว่า
 * (lib: ES2022 ไม่มี DOM types ดังนั้น BufferSource ใช้ไม่ได้)
 */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

/** เข้ารหัส plaintext ด้วย active master key → binary envelope */
export async function encryptEnvelope(
  masterKeys: MasterKeys,
  plaintext: string,
  aad: string,
): Promise<Uint8Array> {
  const key = masterKeys.keys.get(masterKeys.active);
  if (!key) {
    throw new Error(`active master key id ${masterKeys.active} ไม่มีในชุด keys`);
  }

  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(encoder.encode(aad)),
    },
    key,
    toArrayBuffer(encoder.encode(plaintext)),
  );

  const envelope = new Uint8Array(HEADER_BYTES + ciphertext.byteLength);
  envelope[0] = ENVELOPE_VERSION;
  envelope[1] = masterKeys.active;
  envelope.set(nonce, 2);
  envelope.set(new Uint8Array(ciphertext), HEADER_BYTES);
  return envelope;
}

/**
 * ถอดรหัส envelope — เลือก key จาก key_id ใน envelope (รองรับ rotation)
 * envelope ผิด format / key ไม่มี / AAD ไม่ตรง / tampered → throw
 */
export async function decryptEnvelope(
  masterKeys: MasterKeys,
  envelope: Uint8Array,
  aad: string,
): Promise<string> {
  if (envelope.length < HEADER_BYTES + 16) {
    throw new Error("envelope สั้นเกินกว่าจะถูกต้อง");
  }
  const version = envelope[0];
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`envelope version ${version} ไม่รองรับ`);
  }
  const keyId = envelope[1] as number;
  const key = masterKeys.keys.get(keyId);
  if (!key) {
    throw new Error(`master key id ${keyId} ไม่มีในชุด keys — ตรวจสอบ key rotation`);
  }

  const nonce = envelope.slice(2, HEADER_BYTES);
  const ciphertext = envelope.slice(HEADER_BYTES);

  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(encoder.encode(aad)),
      },
      key,
      toArrayBuffer(ciphertext),
    );
    return decoder.decode(plaintext);
  } catch {
    // WebCrypto โยน OperationError ทั้ง tampered และ AAD ไม่ตรง — ไม่แยกแยะเพื่อความปลอดภัย
    throw new Error("decrypt ไม่สำเร็จ — ciphertext เสียหาย, AAD ไม่ตรง หรือ key ผิด");
  }
}
