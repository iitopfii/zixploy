/**
 * isCloudflareIp tests — docs/phase-05-domains.md M5
 *
 * ความถูกต้องของ CIDR matching สำคัญกับความปลอดภัยโดยตรง: false positive แปลว่า
 * DNS ที่ชี้ผิดจริง ๆ ถูกรายงานว่า "proxied" (ปกติ) แล้วผู้ใช้ไม่รู้ว่า domain ใช้ไม่ได้
 */

import { describe, expect, test } from "bun:test";
import { cloudflareTrustedIps, isCloudflareIp } from "../src/cloudflare";

describe("isCloudflareIp — IPv4 ที่อยู่ใน range", () => {
  test.each([
    ["104.21.5.10", "104.16.0.0/13 — range ที่ Cloudflare free plan ใช้บ่อยสุด"],
    ["172.67.100.1", "172.64.0.0/13"],
    ["173.245.48.0", "ขอบล่างของ 173.245.48.0/20 (network address เอง)"],
    ["173.245.63.255", "ขอบบนของ 173.245.48.0/20 (broadcast address)"],
    ["162.158.0.1", "162.158.0.0/15"],
    ["162.159.255.254", "ปลายอีกฝั่งของ /15 ที่ octet ที่สองเปลี่ยน"],
    ["131.0.72.1", "131.0.72.0/22 — range เล็กสุด"],
  ])("%s → true (%s)", (ip) => {
    expect(isCloudflareIp(ip)).toBe(true);
  });
});

describe("isCloudflareIp — IPv4 นอก range", () => {
  test.each([
    ["103.114.203.205", "origin IP จริงของ server"],
    ["8.8.8.8", "Google DNS"],
    ["173.245.47.255", "ต่ำกว่าขอบล่างของ 173.245.48.0/20 อยู่ 1"],
    ["173.245.64.0", "สูงกว่าขอบบนของ 173.245.48.0/20 อยู่ 1"],
    ["104.15.255.255", "ต่ำกว่า 104.16.0.0/13 อยู่ 1"],
    ["104.28.0.0", "เหนือ 104.24.0.0/14 — ยังไม่ใช่ของ Cloudflare"],
    ["131.0.76.0", "เหนือขอบบนของ 131.0.72.0/22"],
    ["192.168.1.1", "private range"],
  ])("%s → false (%s)", (ip) => {
    expect(isCloudflareIp(ip)).toBe(false);
  });
});

describe("isCloudflareIp — IPv6", () => {
  test("2606:4700:: (network address) → true", () => {
    expect(isCloudflareIp("2606:4700::")).toBe(true);
  });

  test("2606:4700:3033::ac43:a86b → true (address จริงที่ Cloudflare ใช้)", () => {
    expect(isCloudflareIp("2606:4700:3033::ac43:a86b")).toBe(true);
  });

  test("2400:cb00:1234:5678::1 → true", () => {
    expect(isCloudflareIp("2400:cb00:1234:5678::1")).toBe(true);
  });

  test("2a06:98c0:: → true (prefix /29 ที่ไม่ตรงขอบ 16-bit)", () => {
    expect(isCloudflareIp("2a06:98c0::")).toBe(true);
  });

  test("2a06:98c7:ffff:: → true (ยังอยู่ใน /29)", () => {
    expect(isCloudflareIp("2a06:98c7:ffff::")).toBe(true);
  });

  test("2a06:98c8:: → false (เลย /29 ไปแล้ว)", () => {
    expect(isCloudflareIp("2a06:98c8::")).toBe(false);
  });

  test("2001:4860:4860::8888 (Google) → false", () => {
    expect(isCloudflareIp("2001:4860:4860::8888")).toBe(false);
  });

  test("::1 (loopback) → false", () => {
    expect(isCloudflareIp("::1")).toBe(false);
  });

  test("bracket-wrapped [2606:4700::] → true", () => {
    expect(isCloudflareIp("[2606:4700::]")).toBe(true);
  });
});

describe("isCloudflareIp — input ที่ผิดรูปแบบต้องไม่ throw และคืน false", () => {
  test.each([
    ["", "ว่าง"],
    ["   ", "ช่องว่างล้วน"],
    ["not-an-ip", "ข้อความทั่วไป"],
    ["999.999.999.999", "octet เกิน 255"],
    ["104.16", "IPv4 ไม่ครบ 4 ส่วน"],
    ["104.16.0.0.1", "IPv4 เกิน 4 ส่วน"],
    ["2606::4700::1", ":: ซ้ำสองครั้ง (ผิด RFC)"],
    ["zzzz::1", "hex ไม่ถูกต้อง"],
  ])("%s → false (%s)", (input) => {
    expect(() => isCloudflareIp(input)).not.toThrow();
    expect(isCloudflareIp(input)).toBe(false);
  });
});

describe("cloudflareTrustedIps", () => {
  test("คืน CIDR ทั้ง v4 และ v6 รวมกัน", () => {
    const ips = cloudflareTrustedIps();
    expect(ips.some((c) => c.includes("."))).toBe(true);
    expect(ips.some((c) => c.includes("::"))).toBe(true);
  });

  test("ทุกรายการเป็น CIDR notation ที่มี prefix", () => {
    for (const cidr of cloudflareTrustedIps()) {
      expect(cidr).toMatch(/\/\d+$/);
    }
  });

  test("ทุก CIDR ที่ประกาศต้องถูกมองว่าเป็นของ Cloudflare เมื่อเอา network address ไปเช็ก", () => {
    // กัน range ที่พิมพ์ผิดจนไม่มีวัน match อะไรเลย
    for (const cidr of cloudflareTrustedIps()) {
      const network = cidr.split("/")[0] as string;
      expect(isCloudflareIp(network)).toBe(true);
    }
  });
});
