/**
 * Encryption envelope tests — docs/encryption.md
 *
 * ตรวจสอบ:
 * - Round-trip encrypt → decrypt
 * - Nonce สุ่มใหม่ทุกครั้ง (ciphertext ต่างกันแม้ plaintext เดิม)
 * - AAD binding: AAD ต่างกัน → decrypt ไม่ได้
 * - Tampering detection: แก้ 1 byte → decrypt ไม่ได้
 * - Key rotation: decrypt ด้วย key เก่าได้ตาม key_id ใน envelope
 * - Envelope format: version + key_id byte ถูกต้อง
 */

import { describe, expect, test } from "bun:test";
import { decryptEnvelope, encryptEnvelope } from "../src/crypto/envelope";
import { createMasterKeys } from "../src/crypto/master-key";

function rawKey(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

async function singleKey(id = 1, fill = 0x42) {
  return createMasterKeys(id, { [id]: rawKey(fill) });
}

describe("encryption envelope — round-trip", () => {
  test("encrypt → decrypt คืน plaintext เดิม", async () => {
    const keys = await singleKey();
    const plaintext = "-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----";
    const envelope = await encryptEnvelope(keys, plaintext, "github_app:abc:pem");
    const decrypted = await decryptEnvelope(keys, envelope, "github_app:abc:pem");
    expect(decrypted).toBe(plaintext);
  });

  test("plaintext ที่มี UTF-8 หลาย byte → round-trip ถูกต้อง", async () => {
    const keys = await singleKey();
    const plaintext = "ทดสอบ UTF-8 🔐 secret";
    const envelope = await encryptEnvelope(keys, plaintext, "test:aad");
    expect(await decryptEnvelope(keys, envelope, "test:aad")).toBe(plaintext);
  });

  test("plaintext ว่าง → round-trip ถูกต้อง", async () => {
    const keys = await singleKey();
    const envelope = await encryptEnvelope(keys, "", "test:aad");
    expect(await decryptEnvelope(keys, envelope, "test:aad")).toBe("");
  });
});

describe("encryption envelope — format", () => {
  test("byte 0 = version 0x01, byte 1 = active key id", async () => {
    const keys = await createMasterKeys(7, { 7: rawKey(0x11) });
    const envelope = await encryptEnvelope(keys, "data", "aad");
    expect(envelope[0]).toBe(0x01);
    expect(envelope[1]).toBe(7);
  });

  test("envelope ยาวกว่า plaintext อย่างน้อย 30 bytes (header 14 + tag 16)", async () => {
    const keys = await singleKey();
    const envelope = await encryptEnvelope(keys, "abc", "aad");
    expect(envelope.length).toBe(3 + 14 + 16);
  });

  test("nonce สุ่มใหม่ทุกครั้ง — ciphertext ต่างกันแม้ plaintext เดิม", async () => {
    const keys = await singleKey();
    const e1 = await encryptEnvelope(keys, "same-plaintext", "same-aad");
    const e2 = await encryptEnvelope(keys, "same-plaintext", "same-aad");
    expect(Buffer.from(e1).toString("hex")).not.toBe(Buffer.from(e2).toString("hex"));
    // แต่ decrypt ได้ทั้งคู่
    expect(await decryptEnvelope(keys, e1, "same-aad")).toBe("same-plaintext");
    expect(await decryptEnvelope(keys, e2, "same-aad")).toBe("same-plaintext");
  });
});

describe("encryption envelope — AAD binding", () => {
  test("AAD ต่างกัน → decrypt ไม่สำเร็จ", async () => {
    const keys = await singleKey();
    const envelope = await encryptEnvelope(keys, "secret", "github_app:app1:pem");
    await expect(decryptEnvelope(keys, envelope, "github_app:app2:pem")).rejects.toThrow();
  });

  test("field ต่างกันใน AAD → decrypt ไม่สำเร็จ (ย้าย ciphertext ข้าม field ไม่ได้)", async () => {
    const keys = await singleKey();
    const envelope = await encryptEnvelope(keys, "secret", "github_app:app1:pem");
    await expect(
      decryptEnvelope(keys, envelope, "github_app:app1:webhook_secret"),
    ).rejects.toThrow();
  });

  test("AAD ว่าง vs AAD มีค่า → decrypt ไม่สำเร็จ", async () => {
    const keys = await singleKey();
    const envelope = await encryptEnvelope(keys, "secret", "");
    await expect(decryptEnvelope(keys, envelope, "something")).rejects.toThrow();
  });
});

describe("encryption envelope — tampering detection", () => {
  test("แก้ ciphertext 1 byte → decrypt ไม่สำเร็จ", async () => {
    const keys = await singleKey();
    const envelope = await encryptEnvelope(keys, "secret data", "aad");
    const tampered = new Uint8Array(envelope);
    // แก้ byte แรกของ ciphertext (หลัง header 14 bytes)
    tampered[14] = (tampered[14]! ^ 0xff) & 0xff;
    await expect(decryptEnvelope(keys, tampered, "aad")).rejects.toThrow();
  });

  test("แก้ nonce → decrypt ไม่สำเร็จ", async () => {
    const keys = await singleKey();
    const envelope = await encryptEnvelope(keys, "secret data", "aad");
    const tampered = new Uint8Array(envelope);
    tampered[2] = (tampered[2]! ^ 0xff) & 0xff;
    await expect(decryptEnvelope(keys, tampered, "aad")).rejects.toThrow();
  });

  test("แก้ GCM tag (byte สุดท้าย) → decrypt ไม่สำเร็จ", async () => {
    const keys = await singleKey();
    const envelope = await encryptEnvelope(keys, "secret data", "aad");
    const tampered = new Uint8Array(envelope);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last]! ^ 0xff) & 0xff;
    await expect(decryptEnvelope(keys, tampered, "aad")).rejects.toThrow();
  });

  test("envelope สั้นเกินไป → throw", async () => {
    const keys = await singleKey();
    await expect(decryptEnvelope(keys, new Uint8Array(10), "aad")).rejects.toThrow(/สั้นเกิน/);
  });

  test("version ไม่รองรับ → throw", async () => {
    const keys = await singleKey();
    const envelope = await encryptEnvelope(keys, "data", "aad");
    const bad = new Uint8Array(envelope);
    bad[0] = 0x99;
    await expect(decryptEnvelope(keys, bad, "aad")).rejects.toThrow(/version/);
  });
});

describe("encryption envelope — key rotation", () => {
  test("decrypt ใช้ key ตาม key_id ใน envelope ไม่ใช่ active key", async () => {
    // เข้ารหัสด้วย key 1
    const keysV1 = await createMasterKeys(1, { 1: rawKey(0x11) });
    const envelope = await encryptEnvelope(keysV1, "old-secret", "aad");
    expect(envelope[1]).toBe(1);

    // rotate: active = 2 แต่ยังมี key 1 อยู่
    const keysV2 = await createMasterKeys(2, { 1: rawKey(0x11), 2: rawKey(0x22) });
    // decrypt ค่าเก่าได้ด้วย key 1 (เลือกจาก key_id ใน envelope)
    expect(await decryptEnvelope(keysV2, envelope, "aad")).toBe("old-secret");

    // ค่าใหม่เข้ารหัสด้วย key 2
    const newEnvelope = await encryptEnvelope(keysV2, "new-secret", "aad");
    expect(newEnvelope[1]).toBe(2);
    expect(await decryptEnvelope(keysV2, newEnvelope, "aad")).toBe("new-secret");
  });

  test("key เก่าถูกลบออกแล้ว → decrypt ค่าเก่าไม่ได้ พร้อม error ชัดเจน", async () => {
    const keysV1 = await createMasterKeys(1, { 1: rawKey(0x11) });
    const envelope = await encryptEnvelope(keysV1, "old-secret", "aad");

    // ลบ key 1 ออก เหลือแค่ key 2
    const keysOnly2 = await createMasterKeys(2, { 2: rawKey(0x22) });
    await expect(decryptEnvelope(keysOnly2, envelope, "aad")).rejects.toThrow(/key id 1/);
  });

  test("key ต่างกัน (same id) → decrypt ไม่สำเร็จ", async () => {
    const keysA = await createMasterKeys(1, { 1: rawKey(0xaa) });
    const keysB = await createMasterKeys(1, { 1: rawKey(0xbb) });
    const envelope = await encryptEnvelope(keysA, "secret", "aad");
    await expect(decryptEnvelope(keysB, envelope, "aad")).rejects.toThrow();
  });
});

describe("createMasterKeys — validation", () => {
  test("key ไม่ใช่ 32 bytes → throw", async () => {
    await expect(createMasterKeys(1, { 1: new Uint8Array(16) })).rejects.toThrow(/32 bytes/);
  });

  test("active key id ไม่มีในชุด keys → throw", async () => {
    await expect(createMasterKeys(3, { 1: rawKey(0x11) })).rejects.toThrow(/active key id 3/);
  });

  test("หลาย key พร้อมกัน → import ได้ทั้งหมด", async () => {
    const keys = await createMasterKeys(2, { 1: rawKey(0x11), 2: rawKey(0x22), 3: rawKey(0x33) });
    expect(keys.keys.size).toBe(3);
    expect(keys.active).toBe(2);
  });
});
