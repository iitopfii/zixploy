/**
 * Cloudflare IP ranges — docs/phase-05-domains.md M5 (Cloudflare proxy support)
 *
 * ใช้ 2 ที่:
 * 1. DNS check (control-api/domains/dns-check.ts) — domain ที่ resolve เป็น Cloudflare IP
 *    ไม่ใช่ "mismatch" แต่เป็น "proxied" (ตั้งใจซ่อน origin IP ไว้หลัง Cloudflare)
 * 2. Traefik trustedIPs (deploy/server/) — ให้ X-Forwarded-For จาก Cloudflare เชื่อถือได้
 *    ไม่งั้น rate limit/audit log จะเห็นแต่ IP ของ Cloudflare edge ไม่ใช่ client จริง
 *
 * ที่มา: https://www.cloudflare.com/ips/ — hardcode แทน fetch runtime โดยตั้งใจ
 * (control plane ต้องทำงานได้แม้ไม่มีเน็ตออกนอก และ range เปลี่ยนน้อยมาก ~ปีละครั้ง)
 * ถ้า Cloudflare เพิ่ม range ใหม่: อัปเดตไฟล์นี้ + deploy/server/traefik-dynamic/ ให้ตรงกัน
 */

/** IPv4 CIDR ของ Cloudflare edge — https://www.cloudflare.com/ips-v4 */
export const CLOUDFLARE_IPV4_RANGES = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
] as const;

/** IPv6 CIDR ของ Cloudflare edge — https://www.cloudflare.com/ips-v6 */
export const CLOUDFLARE_IPV6_RANGES = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
] as const;

// ---------------------------------------------------------------------------
// IP parsing
// ---------------------------------------------------------------------------

/** IPv4 dotted-quad → 32-bit unsigned int, หรือ null ถ้า format ผิด */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result;
}

/**
 * IPv6 → BigInt (128-bit) หรือ null ถ้า format ผิด
 * รองรับ `::` compression และ IPv4-mapped suffix (::ffff:1.2.3.4)
 */
function ipv6ToBigInt(ip: string): bigint | null {
  let input = ip.trim();
  // ตัด zone id (fe80::1%eth0) และ bracket ([::1])
  const pct = input.indexOf("%");
  if (pct !== -1) input = input.slice(0, pct);
  if (input.startsWith("[") && input.endsWith("]")) input = input.slice(1, -1);
  if (!input.includes(":")) return null;

  // IPv4-mapped suffix → แปลงเป็น 2 กลุ่ม hex
  const lastColon = input.lastIndexOf(":");
  const tail = input.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    input = `${input.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const doubleColon = input.indexOf("::");
  let groups: string[];

  if (doubleColon === -1) {
    groups = input.split(":");
    if (groups.length !== 8) return null;
  } else {
    // `::` ปรากฏได้ครั้งเดียวเท่านั้น
    if (input.indexOf("::", doubleColon + 1) !== -1) return null;
    const head = input.slice(0, doubleColon);
    const tailPart = input.slice(doubleColon + 2);
    const headGroups = head ? head.split(":") : [];
    const tailGroups = tailPart ? tailPart.split(":") : [];
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 1) return null;
    groups = [...headGroups, ...Array(missing).fill("0"), ...tailGroups];
  }

  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    result = (result << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return result;
}

// ---------------------------------------------------------------------------
// CIDR matching
// ---------------------------------------------------------------------------

/** ตรวจว่า IPv4 address อยู่ใน CIDR range หรือไม่ */
function ipv4InCidr(ip: string, cidr: string): boolean {
  const [network, prefixStr] = cidr.split("/");
  if (!network || !prefixStr) return false;

  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;

  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(network);
  if (ipInt === null || netInt === null) return false;

  if (prefix === 0) return true;
  // >>> 0 บังคับให้เป็น unsigned (bitwise ของ JS ทำงานบน int32 แบบมีเครื่องหมาย)
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) >>> 0 === (netInt & mask) >>> 0;
}

/** ตรวจว่า IPv6 address อยู่ใน CIDR range หรือไม่ */
function ipv6InCidr(ip: string, cidr: string): boolean {
  const [network, prefixStr] = cidr.split("/");
  if (!network || !prefixStr) return false;

  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return false;

  const ipInt = ipv6ToBigInt(ip);
  const netInt = ipv6ToBigInt(network);
  if (ipInt === null || netInt === null) return false;

  if (prefix === 0) return true;
  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
  return (ipInt & mask) === (netInt & mask);
}

/**
 * ตรวจว่า IP (v4 หรือ v6) เป็นของ Cloudflare edge หรือไม่
 *
 * ใช้ตัดสินว่า DNS ที่ resolve ไม่ตรง configured IP นั้นเป็นเพราะ Cloudflare proxy
 * (ปกติ/ตั้งใจ) ไม่ใช่ผู้ใช้ตั้ง DNS ผิด
 */
export function isCloudflareIp(ip: string): boolean {
  const trimmed = ip.trim();
  if (!trimmed) return false;

  if (trimmed.includes(":")) {
    return CLOUDFLARE_IPV6_RANGES.some((cidr) => ipv6InCidr(trimmed, cidr));
  }
  return CLOUDFLARE_IPV4_RANGES.some((cidr) => ipv4InCidr(trimmed, cidr));
}

/** CIDR ทั้งหมด (v4 + v6) — ใช้สร้าง Traefik trustedIPs / forwardedHeaders config */
export function cloudflareTrustedIps(): string[] {
  return [...CLOUDFLARE_IPV4_RANGES, ...CLOUDFLARE_IPV6_RANGES];
}
