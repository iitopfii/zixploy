import { AppError } from "@zixploy/shared";
import { Elysia } from "elysia";
import { log } from "../logger";

/**
 * Origin/Host validation (Phase 8 M5 — docs/phase-08-production.md "Web Security")
 *
 * ป้องกัน Host header injection (cache poisoning, ลิงก์ผิดใน error page ฯลฯ) และเสริม CSRF
 * double-submit ด้วยการเช็ค `Origin` บน mutating request อีกชั้น — เว็บอื่นปลอมทั้งคุกกี้และ
 * Origin/Host พร้อมกันไม่ได้
 *
 * `ZIXPLOY_BASE_URL` คือ host จริงที่อนุญาต — ไม่ตั้งค่าใน production = ข้ามการตรวจทั้งหมด
 * (fail open พร้อม log.warn ดัง ๆ ตอน startup) เพราะไม่มีทางรู้ host ที่ถูกต้อง และการบล็อก
 * ทุก request ทั้งระบบเพราะ config ขาดหนึ่งตัวเสี่ยงเกินไป (ต่างจาก master key ที่ fail closed
 * เฉพาะ subfeature ที่เกี่ยวข้อง) — operator ต้องตั้งค่านี้เองก่อน deploy จริงเสมอ
 * ใน dev/test อนุโลม localhost/127.0.0.1 เพิ่มเข้า allowlist เพื่อไม่ต้องตั้ง env ทุกครั้งที่รันเทสต์
 */

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function parseAllowedHosts(baseUrl: string | undefined): Set<string> {
  const hosts = new Set<string>();
  if (baseUrl) {
    try {
      hosts.add(new URL(baseUrl).host);
    } catch {
      log.warn("ZIXPLOY_BASE_URL ไม่ใช่ URL ที่ถูกต้อง — origin guard จะไม่นับเป็น allowed host", {
        baseUrl,
      });
    }
  }
  if (!isProduction()) {
    hosts.add("localhost");
    hosts.add("127.0.0.1");
  }
  return hosts;
}

function hostOf(value: string): string | null {
  try {
    // Origin header เป็น URL เต็ม (scheme://host); Host header เป็น host ตรง ๆ
    return value.includes("://") ? new URL(value).host : value;
  } catch {
    return null;
  }
}

export function originGuard(baseUrl = process.env.ZIXPLOY_BASE_URL) {
  const allowedHosts = parseAllowedHosts(baseUrl);

  if (allowedHosts.size === 0) {
    log.warn("origin guard ปิดใช้งาน — ไม่ได้ตั้ง ZIXPLOY_BASE_URL ใน production ตั้งค่าก่อน deploy จริง");
  }

  return new Elysia({ name: "origin-guard" }).onRequest(({ request }) => {
    // ไม่มี allowed host ที่ config ไว้ → ข้าม (ไม่บล็อกทั้งระบบเพราะ config ขาด)
    if (allowedHosts.size === 0) return;

    // HTTP/1.1 บังคับให้ client ส่ง Host header เสมอ — ไม่มีค่าได้เฉพาะ request ที่สร้างในหน่วยความจำ
    // ตรง ๆ (เช่นในเทสต์ที่เรียก app.handle() โดยไม่ผ่าน socket จริง) จึงข้ามแทนที่จะ throw
    const hostHeader = request.headers.get("host");
    if (hostHeader) {
      const requestHost = hostOf(hostHeader);
      if (!requestHost || !allowedHosts.has(requestHost)) {
        throw new AppError("INVALID_HOST", "Host header ไม่ถูกต้องหรือไม่ได้รับอนุญาต");
      }
    }

    if (!MUTATING_METHODS.has(request.method)) return;

    // Origin header ไม่มีเสมอไป (เช่น same-origin GET, บาง client เก่า) — เช็คเฉพาะเมื่อมีค่า
    const origin = request.headers.get("origin");
    if (!origin) return;
    const originHost = hostOf(origin);
    if (!originHost || !allowedHosts.has(originHost)) {
      throw new AppError("INVALID_ORIGIN", "Origin ของ request ไม่ได้รับอนุญาต");
    }
  });
}
