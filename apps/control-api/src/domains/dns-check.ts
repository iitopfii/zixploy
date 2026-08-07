/**
 * DNS check service — docs/phase-05-domains.md M3
 *
 * Resolve A และ AAAA records ของ hostname แล้วเปรียบเทียบกับ configured public IPs
 * ผลลัพธ์:
 *   "valid"    — พบ IP ที่ตรงกับ ZIXPLOY_PUBLIC_IPS อย่างน้อย 1 ตัว
 *   "proxied"  — ทุก IP ที่ resolve ได้เป็นของ Cloudflare edge (M5)
 *   "mismatch" — resolve สำเร็จแต่ไม่ตรง configured IPs และไม่ใช่ Cloudflare
 *   "unknown"  — resolve ล้มเหลว (NXDOMAIN, timeout, network error, ฯลฯ)
 *
 * "proxied" แยกจาก "mismatch" เพราะเป็นสถานะที่ตั้งใจ ไม่ใช่ config ผิด — เมื่อเปิด
 * Cloudflare proxy (DDoS protection) DNS จะชี้ไป Cloudflare edge เสมอ ไม่มีทางชี้มาที่
 * origin IP ได้เลย การรายงานว่า "ยังไม่ชี้มาที่ server" จึงผิดและทำให้ผู้ใช้ไปปิด proxy
 * ทิ้งโดยไม่จำเป็น
 *
 * DNS mismatch ไม่ได้ block การ save domain แต่ต้องแสดง warning ก่อนเปิด HTTPS
 * (phase-05-domains.md §DNS Check)
 */

import dns from "node:dns/promises";
import { type DnsStatus, isCloudflareIp } from "@zixploy/shared";

export type { DnsStatus };

export interface DnsCheckResult {
  status: DnsStatus;
  resolvedAddresses: string[];
  configuredIps: string[];
  /** IP ที่ resolve ได้ซึ่งอยู่ใน Cloudflare range — แสดงใน UI เพื่ออธิบายสถานะ "proxied" */
  cloudflareAddresses: string[];
}

/**
 * อ่าน public IPs จาก ZIXPLOY_PUBLIC_IPS env var (comma-separated)
 * ถ้าไม่ตั้งค่า → คืน [] — check จะได้ "mismatch" เสมอ (แทนที่จะเงียบเปิด HTTPS ที่ยังไม่ verify)
 *
 * format: "1.2.3.4,5.6.7.8,::1"
 */
export function loadConfiguredIps(): string[] {
  const raw = process.env.ZIXPLOY_PUBLIC_IPS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve A + AAAA records ของ hostname แล้วเปรียบเทียบกับ configured IPs
 *
 * @param hostname - hostname ที่ผ่าน validateHostname() แล้ว
 * @param configuredIps - รายการ IP ของ server (จาก loadConfiguredIps())
 * @param timeoutMs - timeout ต่อ DNS query (default 5000ms)
 */
export async function checkDns(
  hostname: string,
  configuredIps: string[],
  timeoutMs = 5_000,
): Promise<DnsCheckResult> {
  const resolved: string[] = [];

  const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
    const timer = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("DNS timeout")), ms),
    );
    return Promise.race([promise, timer]);
  };

  // Resolve A (IPv4)
  try {
    const v4 = await withTimeout(dns.resolve4(hostname), timeoutMs);
    resolved.push(...v4);
  } catch {
    // NXDOMAIN, ENOTFOUND, timeout — ไม่โยน แค่ไม่เพิ่ม address
  }

  // Resolve AAAA (IPv6)
  try {
    const v6 = await withTimeout(dns.resolve6(hostname), timeoutMs);
    resolved.push(...v6);
  } catch {
    // same — ignore silently
  }

  // ถ้า resolve ไม่ได้เลย
  if (resolved.length === 0) {
    return { status: "unknown", resolvedAddresses: [], configuredIps, cloudflareAddresses: [] };
  }

  const cloudflareAddresses = resolved.filter(isCloudflareIp);

  // ตรวจว่ามี IP ที่ตรงกัน
  const configuredSet = new Set(configuredIps.map((ip) => ip.toLowerCase()));
  const hasMatch = resolved.some((ip) => configuredSet.has(ip.toLowerCase()));

  // ตรงตัวใดตัวหนึ่งชนะเสมอ — origin ชี้ตรงมาที่เราจริง
  // (บาง record set มีทั้ง A ที่ proxied และ AAAA ที่ไม่ proxied ปนกัน)
  let status: DnsStatus;
  if (hasMatch) {
    status = "valid";
  } else if (cloudflareAddresses.length === resolved.length) {
    // ทุก IP เป็น Cloudflare — proxy เปิดอยู่ ไม่มีทางเห็น origin IP จากภายนอก
    status = "proxied";
  } else {
    status = "mismatch";
  }

  return { status, resolvedAddresses: resolved, configuredIps, cloudflareAddresses };
}
