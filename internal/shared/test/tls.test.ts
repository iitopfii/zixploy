/**
 * TLS certificate validation tests — docs/phase-05-domains.md M5
 *
 * ทุกเคสที่ปฏิเสธในนี้คือเคสที่ถ้าปล่อยผ่านจะทำให้ Traefik โหลด config ไม่ได้ (ทั้งไฟล์
 * ไม่ใช่แค่ใบเดียว) หรือ serve cert ผิด domain — ต้อง fail ตอนอัปโหลด ไม่ใช่ตอน reload
 */

import { describe, expect, test } from "bun:test";
import {
  CERT_EXPIRY_WARNING_DAYS,
  certCoversHostname,
  daysUntilExpiry,
  parseCertificate,
  splitCertificateChain,
  validateCertificateBundle,
} from "../src/tls";
import {
  ENCRYPTED_KEY,
  UNRELATED_KEY,
  VALID_CERT,
  VALID_KEY,
  WILDCARD_CERT,
  WILDCARD_KEY,
} from "./fixtures/certificates";

// ---------------------------------------------------------------------------
// splitCertificateChain
// ---------------------------------------------------------------------------

describe("splitCertificateChain", () => {
  test("cert ใบเดียว → 1 block", () => {
    expect(splitCertificateChain(VALID_CERT)).toHaveLength(1);
  });

  test("chain 2 ใบ → 2 block เรียงตามลำดับในไฟล์ (leaf ก่อน)", () => {
    const chain = splitCertificateChain(`${VALID_CERT}${WILDCARD_CERT}`);
    expect(chain).toHaveLength(2);
    // ใบแรกต้องเป็น leaf ที่ parse แล้วได้ example.com ไม่ใช่ wildcard
    expect(parseCertificate(chain[0] as string).hostnames).toContain("example.com");
  });

  test("ข้อความที่ไม่มี certificate → []", () => {
    expect(splitCertificateChain("ไม่ใช่ PEM")).toEqual([]);
  });

  test("BEGIN ที่ไม่มี END คู่ → ข้ามไป ไม่ throw", () => {
    expect(splitCertificateChain("-----BEGIN CERTIFICATE-----\nabc\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseCertificate
// ---------------------------------------------------------------------------

describe("parseCertificate", () => {
  test("ดึง CN + SAN ครบ", () => {
    const parsed = parseCertificate(VALID_CERT);
    expect(parsed.hostnames).toContain("example.com");
    expect(parsed.hostnames).toContain("www.example.com");
  });

  test("hostnames ไม่ซ้ำแม้ CN จะอยู่ใน SAN ด้วย", () => {
    const parsed = parseCertificate(VALID_CERT);
    const unique = new Set(parsed.hostnames);
    expect(parsed.hostnames).toHaveLength(unique.size);
  });

  test("fingerprint เป็น SHA-256 hex คั่นด้วย colon", () => {
    const parsed = parseCertificate(VALID_CERT);
    expect(parsed.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  test("self-signed ถูกตรวจพบ (issuer == subject)", () => {
    expect(parseCertificate(VALID_CERT).selfSigned).toBe(true);
  });

  test("cert ที่ไม่มี subject (SAN-only) parse ได้ ไม่ throw", () => {
    // RFC 5280 อนุญาต — CA สมัยใหม่ deprecate CN สำหรับ hostname ไปแล้ว
    const parsed = parseCertificate(WILDCARD_CERT);
    expect(parsed.subject).toBe("");
    expect(parsed.hostnames).toContain("*.example.com");
  });

  test("cert ที่ subject และ issuer ว่างทั้งคู่ ไม่ถูกนับเป็น self-signed", () => {
    expect(parseCertificate(WILDCARD_CERT).selfSigned).toBe(false);
  });

  test("validFrom/validTo เป็น epoch ms ที่ใช้ได้", () => {
    const parsed = parseCertificate(VALID_CERT);
    expect(Number.isFinite(parsed.validFrom)).toBe(true);
    expect(parsed.validTo).toBeGreaterThan(parsed.validFrom);
  });

  test("PEM ที่ไม่ใช่ certificate → throw", () => {
    expect(() => parseCertificate(VALID_KEY)).toThrow(/ไม่พบ certificate/);
  });

  test("certificate ที่ base64 เสียหาย → throw แบบไม่รั่วเนื้อ PEM ออกมาใน message", () => {
    const broken = "-----BEGIN CERTIFICATE-----\nSECRETDATA!!!\n-----END CERTIFICATE-----";
    expect(() => parseCertificate(broken)).toThrow(/parse certificate ไม่สำเร็จ/);
    try {
      parseCertificate(broken);
    } catch (err) {
      expect((err as Error).message).not.toContain("SECRETDATA");
    }
  });
});

// ---------------------------------------------------------------------------
// certCoversHostname — wildcard semantics (RFC 6125)
// ---------------------------------------------------------------------------

describe("certCoversHostname", () => {
  const exact = parseCertificate(VALID_CERT);
  const wildcard = parseCertificate(WILDCARD_CERT);

  test("exact match", () => {
    expect(certCoversHostname(exact, "example.com")).toBe(true);
  });

  test("SAN entry match", () => {
    expect(certCoversHostname(exact, "www.example.com")).toBe(true);
  });

  test("hostname ที่ไม่อยู่ในใบ → false", () => {
    expect(certCoversHostname(exact, "other.com")).toBe(false);
  });

  test("subdomain ที่ไม่ได้ระบุ → false (cert ธรรมดาไม่ครอบ subdomain อัตโนมัติ)", () => {
    expect(certCoversHostname(exact, "api.example.com")).toBe(false);
  });

  test("case-insensitive", () => {
    expect(certCoversHostname(exact, "EXAMPLE.COM")).toBe(true);
  });

  test("wildcard ครอบ 1 label", () => {
    expect(certCoversHostname(wildcard, "www.example.com")).toBe(true);
    expect(certCoversHostname(wildcard, "api.example.com")).toBe(true);
  });

  test("wildcard ไม่ครอบ bare domain (RFC 6125)", () => {
    expect(certCoversHostname(wildcard, "example.com")).toBe(false);
  });

  test("wildcard ไม่ครอบหลาย label (*.example.com ไม่ครอบ a.b.example.com)", () => {
    expect(certCoversHostname(wildcard, "a.b.example.com")).toBe(false);
  });

  test("wildcard ไม่ครอบ domain ที่แค่ลงท้ายคล้ายกัน (notexample.com)", () => {
    expect(certCoversHostname(wildcard, "www.notexample.com")).toBe(false);
  });

  test("hostname ว่าง → false", () => {
    expect(certCoversHostname(exact, "  ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCertificateBundle
// ---------------------------------------------------------------------------

describe("validateCertificateBundle — เคสที่ผ่าน", () => {
  test("cert + key ที่คู่กันและครอบ hostname", () => {
    const parsed = validateCertificateBundle(VALID_CERT, VALID_KEY, { hostname: "example.com" });
    expect(parsed.hostnames).toContain("example.com");
  });

  test("ไม่ระบุ hostname → ข้ามการตรวจ coverage", () => {
    expect(() => validateCertificateBundle(VALID_CERT, VALID_KEY)).not.toThrow();
  });

  test("wildcard cert ครอบ subdomain", () => {
    expect(() =>
      validateCertificateBundle(WILDCARD_CERT, WILDCARD_KEY, { hostname: "app.example.com" }),
    ).not.toThrow();
  });

  test("cert หมดอายุแล้วแต่ rejectExpired=false → ผ่าน", () => {
    const parsed = parseCertificate(VALID_CERT);
    expect(() =>
      validateCertificateBundle(VALID_CERT, VALID_KEY, {
        rejectExpired: false,
        now: parsed.validTo + 1,
      }),
    ).not.toThrow();
  });
});

describe("validateCertificateBundle — เคสที่ต้องปฏิเสธ", () => {
  test("key ไม่ตรงกับ cert", () => {
    expect(() =>
      validateCertificateBundle(VALID_CERT, UNRELATED_KEY, { hostname: "example.com" }),
    ).toThrow(/ไม่ตรงกับ certificate/);
  });

  test("key มี passphrase (Traefik อ่านไม่ได้)", () => {
    expect(() => validateCertificateBundle(VALID_CERT, ENCRYPTED_KEY)).toThrow(/passphrase/);
  });

  test("ไม่มี key block เลย", () => {
    expect(() => validateCertificateBundle(VALID_CERT, "ไม่ใช่ key")).toThrow(/ไม่พบ private key/);
  });

  test("ไม่มี cert block เลย", () => {
    expect(() => validateCertificateBundle("ไม่ใช่ cert", VALID_KEY)).toThrow(/ไม่พบ certificate/);
  });

  test("cert หมดอายุแล้ว (จำลองด้วย now หลัง validTo)", () => {
    const parsed = parseCertificate(VALID_CERT);
    expect(() =>
      validateCertificateBundle(VALID_CERT, VALID_KEY, { now: parsed.validTo + 1 }),
    ).toThrow(/หมดอายุ/);
  });

  test("cert ยังไม่ถึงวันเริ่มใช้งาน (จำลองด้วย now ก่อน validFrom)", () => {
    const parsed = parseCertificate(VALID_CERT);
    expect(() =>
      validateCertificateBundle(VALID_CERT, VALID_KEY, { now: parsed.validFrom - 1 }),
    ).toThrow(/ยังไม่ถึงวันเริ่มใช้งาน/);
  });

  test("hostname ไม่อยู่ในใบ — error บอกว่าใบนี้ครอบอะไรบ้าง (actionable)", () => {
    expect(() =>
      validateCertificateBundle(VALID_CERT, VALID_KEY, { hostname: "other.com" }),
    ).toThrow(/ไม่ครอบ hostname "other.com"/);
    try {
      validateCertificateBundle(VALID_CERT, VALID_KEY, { hostname: "other.com" });
    } catch (err) {
      expect((err as Error).message).toContain("example.com");
    }
  });

  test("wildcard cert ไม่ครอบ bare domain", () => {
    expect(() =>
      validateCertificateBundle(WILDCARD_CERT, WILDCARD_KEY, { hostname: "example.com" }),
    ).toThrow(/ไม่ครอบ hostname/);
  });

  test("cert ใหญ่เกิน MAX_PEM_BYTES", () => {
    expect(() => validateCertificateBundle("x".repeat(70_000), VALID_KEY)).toThrow(/ยาวเกิน/);
  });

  test("key ใหญ่เกิน MAX_PEM_BYTES", () => {
    expect(() => validateCertificateBundle(VALID_CERT, "x".repeat(70_000))).toThrow(/ยาวเกิน/);
  });

  test("error message ไม่มีเนื้อ private key อยู่ในนั้น", () => {
    // key ที่ parse ไม่ได้แต่มี header ถูกต้อง — path ที่เสี่ยงสุดที่ runtime จะ echo เนื้อ key กลับมา
    const brokenKey =
      "-----BEGIN PRIVATE KEY-----\nSUPERSECRETKEYMATERIAL\n-----END PRIVATE KEY-----";
    try {
      validateCertificateBundle(VALID_CERT, brokenKey);
      throw new Error("ควร throw");
    } catch (err) {
      expect((err as Error).message).not.toContain("SUPERSECRETKEYMATERIAL");
    }
  });
});

// ---------------------------------------------------------------------------
// daysUntilExpiry
// ---------------------------------------------------------------------------

describe("daysUntilExpiry", () => {
  const DAY = 86_400_000;

  test("cert ที่เหลือ 30 วันพอดี", () => {
    const now = 1_000_000_000_000;
    expect(daysUntilExpiry(now + 30 * DAY, now)).toBe(30);
  });

  test("cert ที่หมดอายุแล้ว → ติดลบ", () => {
    const now = 1_000_000_000_000;
    expect(daysUntilExpiry(now - 5 * DAY, now)).toBeLessThan(0);
  });

  test("CERT_EXPIRY_WARNING_DAYS ใช้เตือนล่วงหน้าได้จริง", () => {
    const now = 1_000_000_000_000;
    const notAfter = now + (CERT_EXPIRY_WARNING_DAYS - 1) * DAY;
    expect(daysUntilExpiry(notAfter, now)).toBeLessThan(CERT_EXPIRY_WARNING_DAYS);
  });
});
