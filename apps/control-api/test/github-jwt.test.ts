import { describe, expect, test } from "bun:test";
import {
  decodeJwtPayload,
  importRsaPrivateKey,
  JWT_MAX_TTL_SECONDS,
  signGitHubJwt,
} from "../src/github/jwt";

/**
 * สร้าง RSA key pair สำหรับเทสต์ — ไม่ใช้ key จริง
 * เทสต์นี้ตรวจ JWT structure และ claims ไม่ใช่ signature ของ GitHub จริง
 */
async function generateTestKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  return { privateKey: keyPair.privateKey, publicKey: keyPair.publicKey };
}

async function exportPrivateKeyAsPem(key: CryptoKey): Promise<string> {
  const der = await crypto.subtle.exportKey("pkcs8", key);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

async function verifyJwt(jwt: string, publicKey: CryptoKey): Promise<boolean> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const rawSig = Uint8Array.from(
    atob((parts[2] ?? "").replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, rawSig, data);
}

describe("GitHub App JWT", () => {
  test("สร้าง JWT 3 parts ที่มี header, payload, signature", async () => {
    const { privateKey } = await generateTestKeyPair();
    const jwt = await signGitHubJwt("123456", privateKey);

    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
  });

  test("header มี alg=RS256 และ typ=JWT", async () => {
    const { privateKey } = await generateTestKeyPair();
    const jwt = await signGitHubJwt("123456", privateKey);

    const headerB64 = jwt.split(".")[0] ?? "";
    const header = JSON.parse(atob(headerB64.replace(/-/g, "+").replace(/_/g, "/")));
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");
  });

  test("payload มี iss = appId", async () => {
    const { privateKey } = await generateTestKeyPair();
    const jwt = await signGitHubJwt("my-app-789", privateKey);
    const payload = decodeJwtPayload(jwt);

    expect(payload.iss).toBe("my-app-789");
  });

  test("payload มี iat ถอยหลัง 60 วินาที", async () => {
    const { privateKey } = await generateTestKeyPair();
    const nowSecs = Math.floor(Date.now() / 1000);
    const jwt = await signGitHubJwt("123", privateKey, nowSecs);
    const payload = decodeJwtPayload(jwt);

    expect(payload.iat).toBe(nowSecs - 60);
  });

  test(`payload มี exp ไม่เกิน ${JWT_MAX_TTL_SECONDS / 60} นาที`, async () => {
    const { privateKey } = await generateTestKeyPair();
    const nowSecs = Math.floor(Date.now() / 1000);
    const jwt = await signGitHubJwt("123", privateKey, nowSecs);
    const payload = decodeJwtPayload(jwt);

    const ttl = (payload.exp as number) - nowSecs;
    expect(ttl).toBeLessThanOrEqual(JWT_MAX_TTL_SECONDS);
    expect(ttl).toBeGreaterThan(0);
  });

  test("signature ตรวจผ่าน public key ได้", async () => {
    const { privateKey, publicKey } = await generateTestKeyPair();
    const jwt = await signGitHubJwt("123456", privateKey);
    expect(await verifyJwt(jwt, publicKey)).toBe(true);
  });

  test("signature ไม่ผ่านถ้าแก้ payload", async () => {
    const { privateKey, publicKey } = await generateTestKeyPair();
    const jwt = await signGitHubJwt("123456", privateKey);
    const parts = jwt.split(".");
    // แก้ payload
    const tamperedPayload = btoa(JSON.stringify({ iss: "hacker", iat: 1, exp: 9999999999 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    expect(await verifyJwt(tampered, publicKey)).toBe(false);
  });

  test("importRsaPrivateKey รับ PKCS#8 PEM ได้", async () => {
    const { privateKey } = await generateTestKeyPair();
    const pem = await exportPrivateKeyAsPem(privateKey);

    // ไม่ throw = pass
    const imported = await importRsaPrivateKey(pem);
    expect(imported).toBeDefined();
  });

  test("importRsaPrivateKey โยน error ถ้า PEM ไม่ถูกต้อง", async () => {
    await expect(importRsaPrivateKey("not-a-pem")).rejects.toThrow();
  });

  test("importRsaPrivateKey โยน error ถ้า base64 เสียหาย", async () => {
    const badPem = "-----BEGIN PRIVATE KEY-----\nNOT_VALID_BASE64!!!!\n-----END PRIVATE KEY-----";
    await expect(importRsaPrivateKey(badPem)).rejects.toThrow();
  });

  test("JWT สร้างด้วย imported key แล้วตรวจผ่าน", async () => {
    const { privateKey, publicKey } = await generateTestKeyPair();
    const pem = await exportPrivateKeyAsPem(privateKey);

    const importedKey = await importRsaPrivateKey(pem);
    const jwt = await signGitHubJwt("re-imported", importedKey);

    expect(await verifyJwt(jwt, publicKey)).toBe(true);
  });
});
