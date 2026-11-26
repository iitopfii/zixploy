/**
 * TLS certificate parsing/validation — docs/phase-05-domains.md M5 (custom certificate upload)
 *
 * ใช้ `node:crypto` X509Certificate (มีใน Bun) — ไม่เพิ่ม dependency ภายนอก
 *
 * Security:
 * - ทุก PEM ที่รับจากผู้ใช้ต้องผ่าน validateCertificateBundle() ก่อน persist เสมอ
 *   (parse ไม่ผ่าน = ปฏิเสธ ไม่ใช่เก็บไว้แล้วให้ Traefik พังตอน reload)
 * - private key ต้องคู่กับ cert จริง (checkPrivateKey) — กันอัปโหลดสลับไฟล์
 * - hostname ต้องอยู่ใน CN/SAN — กันเอา cert ของ domain อื่นมาใช้
 * - private key ห้ามเข้า log/error message — error ที่โยนจากไฟล์นี้อ้างถึงแค่ "key" ไม่ใส่เนื้อ PEM
 */

import { createPrivateKey, X509Certificate } from "node:crypto";
import { LocalizedError } from "./i18n";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedCertificate {
  subject: string;
  issuer: string;
  /** CN + SAN DNS entries (lowercase) — รวม wildcard เช่น "*.example.com" */
  hostnames: string[];
  /** epoch ms */
  validFrom: number;
  /** epoch ms */
  validTo: number;
  /** SHA-256 fingerprint (colon-separated hex) — แสดงใน UI ให้ผู้ใช้ verify ได้ */
  fingerprint: string;
  /** self-signed (issuer == subject) — เตือนได้ แต่ไม่ปฏิเสธ (Cloudflare Origin CA ก็ไม่ใช่ public CA) */
  selfSigned: boolean;
}

// ---------------------------------------------------------------------------
// PEM structure checks
// ---------------------------------------------------------------------------

const CERT_BEGIN = "-----BEGIN CERTIFICATE-----";
const KEY_BEGIN_RE = /-----BEGIN (RSA |EC |ENCRYPTED )?PRIVATE KEY-----/;
const ENCRYPTED_KEY_RE = /-----BEGIN ENCRYPTED PRIVATE KEY-----|Proc-Type:\s*4,ENCRYPTED/;

/** ขนาดสูงสุดของ PEM ที่รับ — chain ยาวสุดที่เจอจริงยังไม่ถึง 32KB */
export const MAX_PEM_BYTES = 64 * 1024;

/**
 * แยก PEM chain เป็น certificate ทีละใบ (leaf ใบแรกเสมอตามธรรมเนียม PEM bundle)
 * คืน [] ถ้าไม่พบ certificate block ใด ๆ
 */
export function splitCertificateChain(pem: string): string[] {
  const blocks: string[] = [];
  const parts = pem.split(CERT_BEGIN);
  for (const part of parts.slice(1)) {
    const endIdx = part.indexOf("-----END CERTIFICATE-----");
    if (endIdx === -1) continue;
    blocks.push(`${CERT_BEGIN}${part.slice(0, endIdx)}-----END CERTIFICATE-----\n`);
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * ดึง DNS hostnames จาก subjectAltName string ของ X509Certificate
 * format: `DNS:example.com, DNS:*.example.com, IP Address:1.2.3.4`
 */
function extractSanHostnames(subjectAltName: string | undefined): string[] {
  if (!subjectAltName) return [];
  return subjectAltName
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.toUpperCase().startsWith("DNS:"))
    .map((entry) => entry.slice(4).trim().toLowerCase())
    .filter(Boolean);
}

/**
 * ดึง CN จาก subject string (`CN=example.com\nO=Foo`)
 *
 * subject เป็น undefined ได้จริง: cert ที่ไม่มี subject เลย (SAN-only) ถูกต้องตาม RFC 5280
 * และพบมากขึ้นเรื่อย ๆ เพราะ CA สมัยใหม่ deprecate CN สำหรับ hostname ไปแล้ว
 */
function extractCommonName(subject: string | undefined): string | null {
  if (!subject) return null;
  for (const line of subject.split(/[\n,]/)) {
    const trimmed = line.trim();
    if (trimmed.toUpperCase().startsWith("CN=")) {
      return trimmed.slice(3).trim().toLowerCase() || null;
    }
  }
  return null;
}

/**
 * Parse leaf certificate (ใบแรกของ chain) — โยน Error ถ้า PEM ผิดรูปแบบ
 * ไม่ตรวจ expiry/hostname ที่นี่ (ดู validateCertificateBundle)
 */
export function parseCertificate(certPem: string): ParsedCertificate {
  const chain = splitCertificateChain(certPem);
  const leafPem = chain[0];
  if (!leafPem) {
    throw new LocalizedError({
      th: "ไม่พบ certificate ใน PEM ที่ส่งมา (ต้องมี -----BEGIN CERTIFICATE-----)",
      en: "No certificate found in the PEM provided (-----BEGIN CERTIFICATE----- is required)",
    });
  }

  let cert: X509Certificate;
  try {
    cert = new X509Certificate(leafPem);
  } catch {
    // ไม่ส่ง original error ต่อ — บาง runtime ใส่เนื้อ PEM ลงใน message
    throw new LocalizedError({
      th: "parse certificate ไม่สำเร็จ — ตรวจสอบว่าเป็น PEM ที่ถูกต้อง",
      en: "Could not parse the certificate. Check that it is a valid PEM",
    });
  }

  const cn = extractCommonName(cert.subject);
  const sans = extractSanHostnames(cert.subjectAltName);
  const hostnames = [...new Set([...(cn ? [cn] : []), ...sans])];

  const validFrom = Date.parse(cert.validFrom);
  const validTo = Date.parse(cert.validTo);
  if (Number.isNaN(validFrom) || Number.isNaN(validTo)) {
    throw new LocalizedError({
      th: "certificate มีวันหมดอายุที่อ่านไม่ได้",
      en: "The certificate has an unreadable expiry date",
    });
  }

  // subject/issuer เป็น undefined ได้เมื่อ cert ไม่มี field นั้น — normalize เป็น "" ตั้งแต่ต้นทาง
  // ไม่งั้น consumer ทุกตัว (DB column, UI, DTO) ต้องจัดการ undefined เองซ้ำ ๆ
  const subject = cert.subject ?? "";
  const issuer = cert.issuer ?? "";

  return {
    subject,
    issuer,
    hostnames,
    validFrom,
    validTo,
    fingerprint: cert.fingerprint256,
    // cert ที่ไม่มีทั้ง subject และ issuer ไม่ใช่ self-signed — เป็นแค่ field ว่างทั้งคู่
    selfSigned: subject !== "" && subject === issuer,
  };
}

// ---------------------------------------------------------------------------
// Hostname matching
// ---------------------------------------------------------------------------

/**
 * ตรวจว่า certificate ครอบ hostname นี้หรือไม่ (รองรับ wildcard 1 ระดับตาม RFC 6125)
 *
 * `*.example.com` ครอบ `www.example.com` แต่ **ไม่ครอบ** `example.com` หรือ `a.b.example.com`
 */
export function certCoversHostname(parsed: ParsedCertificate, hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return false;

  for (const entry of parsed.hostnames) {
    if (entry === host) return true;

    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // ".example.com"
      // ต้องเหลือ label เดียวหน้า suffix เท่านั้น
      if (host.endsWith(suffix)) {
        const prefix = host.slice(0, host.length - suffix.length);
        if (prefix.length > 0 && !prefix.includes(".")) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Bundle validation
// ---------------------------------------------------------------------------

export interface CertificateValidationOptions {
  /** hostname ที่ cert ต้องครอบ — ข้ามการตรวจถ้าไม่ระบุ */
  hostname?: string;
  /** ถือว่า cert ที่หมดอายุแล้วเป็น error (default: true) */
  rejectExpired?: boolean;
  /** เวลาอ้างอิงสำหรับตรวจ expiry (default: Date.now()) — ให้เทสต์ pin เวลาได้ */
  now?: number;
}

/**
 * ตรวจ certificate bundle ทั้งชุดก่อน persist
 *
 * ตรวจตามลำดับ (fail เร็วที่สุดก่อน):
 * 1. ขนาด PEM ไม่เกิน MAX_PEM_BYTES
 * 2. key ไม่ถูกเข้ารหัสด้วย passphrase (Traefik อ่านไม่ได้)
 * 3. cert parse ได้
 * 4. key parse ได้และเป็นคู่กับ cert
 * 5. cert ยังไม่หมดอายุ / ยังไม่ถึงวันเริ่มใช้
 * 6. cert ครอบ hostname ที่ระบุ
 */
export function validateCertificateBundle(
  certPem: string,
  keyPem: string,
  options: CertificateValidationOptions = {},
): ParsedCertificate {
  const { hostname, rejectExpired = true, now = Date.now() } = options;

  // 1. ขนาด
  if (Buffer.byteLength(certPem, "utf8") > MAX_PEM_BYTES) {
    throw new LocalizedError({
      th: `certificate ยาวเกิน ${MAX_PEM_BYTES} bytes`,
      en: `Certificate is larger than ${MAX_PEM_BYTES} bytes`,
    });
  }
  if (Buffer.byteLength(keyPem, "utf8") > MAX_PEM_BYTES) {
    throw new LocalizedError({
      th: `private key ยาวเกิน ${MAX_PEM_BYTES} bytes`,
      en: `Private key is larger than ${MAX_PEM_BYTES} bytes`,
    });
  }

  // 2. key format
  if (!KEY_BEGIN_RE.test(keyPem)) {
    throw new LocalizedError({
      th: "ไม่พบ private key ใน PEM ที่ส่งมา (ต้องมี -----BEGIN PRIVATE KEY-----)",
      en: "No private key found in the PEM provided (-----BEGIN PRIVATE KEY----- is required)",
    });
  }
  if (ENCRYPTED_KEY_RE.test(keyPem)) {
    throw new LocalizedError({
      th: "private key ถูกเข้ารหัสด้วย passphrase — Traefik อ่านไม่ได้ ให้ถอด passphrase ก่อนอัปโหลด",
      en: "The private key is encrypted with a passphrase and Traefik cannot read it. Remove the passphrase before uploading",
    });
  }

  // 3. cert
  const parsed = parseCertificate(certPem);

  // 4. key ↔ cert pairing
  const leafPem = splitCertificateChain(certPem)[0] as string;
  let keyMatches: boolean;
  try {
    const privateKey = createPrivateKey(keyPem);
    keyMatches = new X509Certificate(leafPem).checkPrivateKey(privateKey);
  } catch {
    throw new LocalizedError({
      th: "parse private key ไม่สำเร็จ — ตรวจสอบว่าเป็น PEM ที่ถูกต้องและไม่มี passphrase",
      en: "Could not parse the private key. Check that it is a valid PEM without a passphrase",
    });
  }
  if (!keyMatches) {
    throw new LocalizedError({
      th: "private key ไม่ตรงกับ certificate — ตรวจสอบว่าอัปโหลดไฟล์คู่กันถูกต้อง",
      en: "The private key does not match the certificate. Check that you uploaded the matching pair",
    });
  }

  // 5. expiry
  if (rejectExpired) {
    if (now > parsed.validTo) {
      throw new LocalizedError({
        th: `certificate หมดอายุแล้วเมื่อ ${new Date(parsed.validTo).toISOString().slice(0, 10)}`,
        en: `The certificate expired on ${new Date(parsed.validTo).toISOString().slice(0, 10)}`,
      });
    }
    if (now < parsed.validFrom) {
      throw new LocalizedError({
        th: `certificate ยังไม่ถึงวันเริ่มใช้งาน (${new Date(parsed.validFrom).toISOString().slice(0, 10)})`,
        en: `The certificate is not valid yet (starts ${new Date(parsed.validFrom).toISOString().slice(0, 10)})`,
      });
    }
  }

  // 6. hostname coverage
  if (hostname && !certCoversHostname(parsed, hostname)) {
    throw new LocalizedError({
      th: `certificate ไม่ครอบ hostname "${hostname}" — ใบนี้ออกให้กับ: ${parsed.hostnames.join(", ") || "(ไม่ระบุ)"}`,
      en: `The certificate does not cover hostname "${hostname}". It was issued for: ${parsed.hostnames.join(", ") || "(none)"}`,
    });
  }

  return parsed;
}

/** จำนวนวันที่เหลือก่อน certificate หมดอายุ (ติดลบ = หมดอายุแล้ว) */
export function daysUntilExpiry(validTo: number, now: number = Date.now()): number {
  return Math.floor((validTo - now) / 86_400_000);
}

/** เตือนล่วงหน้ากี่วันก่อน cert หมดอายุ — custom cert ไม่ต่ออายุเองต้องเตือนผู้ใช้ */
export const CERT_EXPIRY_WARNING_DAYS = 30;
