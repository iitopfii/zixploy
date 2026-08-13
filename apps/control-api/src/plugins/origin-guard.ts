import { API_PREFIX, AppError } from "@zixploy/shared";
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

/**
 * Health endpoint ได้รับยกเว้นการตรวจ Host — infra ที่ probe มาต่อด้วย loopback/service IP เสมอ
 * (Docker healthcheck ยิง `Host: 127.0.0.1:3001`, load balancer/uptime monitor ก็คล้ายกัน) ไม่มีทาง
 * รู้ public hostname ที่ config ไว้
 *
 * ปลอดภัยที่จะยกเว้นเพราะ endpoint นี้ไม่ต้อง auth, เป็น GET อย่างเดียว, และคืน JSON คงที่ที่ไม่
 * สะท้อน Host header กลับไปเลย — สิ่งที่ Host validation ป้องกัน (cache poisoning, ลิงก์ผิดใน
 * response) จึงไม่มีช่องเกิดตรงนี้
 *
 * ถ้าไม่ยกเว้น: NODE_ENV=production จะตัด 127.0.0.1 ออกจาก allowlist → healthcheck ได้ 400 →
 * container ขึ้น unhealthy → Traefik ข้าม container → API ตายทั้งระบบ (เคยเกิดจริงบน production)
 */
const HEALTH_PATH = `${API_PREFIX}/system/health`;

/**
 * terminal relay ฝั่ง worker (apps/control-api/src/routes/terminal.ts) ยกเว้นการตรวจ Host
 * เหมือนกัน — ตั้งใจอยู่นอก API_PREFIX เพื่อให้ Traefik (PathPrefix('/api/')) ไม่รู้จัก path นี้
 * เลย แต่ origin guard ทำงาน**ก่อน**ถึง Traefik เสมอ (มันคือ middleware ข้างใน control-api เอง)
 * worker ต่อเข้ามาผ่าน container DNS ตรง ๆ (`control-api:<port>`) จึงส่ง Host header เป็นชื่อ
 * container ซึ่งไม่มีทางอยู่ใน allowlist ของ ZIXPLOY_BASE_URL ได้เลย — ถ้าไม่ยกเว้น worker จะต่อ
 * ไม่ได้ทุกครั้งบนเครื่องที่ตั้ง ZIXPLOY_BASE_URL ไว้ (คือทุกเครื่อง production ตามที่แนะนำ)
 * ปลอดภัยที่จะยกเว้นเพราะ path นี้มี defense-in-depth อีกสองชั้นอยู่แล้ว: (1) Traefik ไม่รู้จัก
 * path นี้เลยจาก public internet และ (2) bearer token (internal-token.ts) ที่ route ต้องเช็คเอง
 */
const TERMINAL_RELAY_PATH_PREFIX = "/internal/terminal-relay/";

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function parseAllowedHosts(baseUrl: string | undefined): Set<string> {
  const hosts = new Set<string>();
  if (baseUrl) {
    try {
      // ใช้ .hostname (ไม่มี port) เพื่อให้เปรียบเทียบกับ Host header ที่อาจมีหรือไม่มี port ได้
      hosts.add(new URL(baseUrl).hostname);
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
    if (value.includes("://")) {
      // Origin header — ดึง hostname ไม่รวม port
      return new URL(value).hostname;
    }
    // Host header อาจมี port (เช่น "127.0.0.1:3001", "example.com:8080", "[::1]:443")
    // strip port ออก: จับ host ส่วนที่ไม่ใช่ port suffix
    const m = value.match(/^(\[.+?\]|[^:]+)(?::\d+)?$/);
    return m?.[1] ?? value;
  } catch {
    return null;
  }
}

export interface OriginGuardOptions {
  /**
   * Host เพิ่มเติมที่อนุญาต — เรียกทุก request (ต้องถูกมาก ห้ามแตะ I/O)
   * ใช้กับ dashboard domain ที่ตั้งจาก UI (Phase 14, settings/store.ts cache ใน memory)
   * คืน null = ไม่มีค่าเพิ่ม
   */
  extraHost?: () => string | null;
}

export function originGuard(
  baseUrl = process.env.ZIXPLOY_BASE_URL,
  options: OriginGuardOptions = {},
) {
  const allowedHosts = parseAllowedHosts(baseUrl);
  const { extraHost } = options;

  if (allowedHosts.size === 0) {
    log.warn("origin guard ปิดใช้งาน — ไม่ได้ตั้ง ZIXPLOY_BASE_URL ใน production ตั้งค่าก่อน deploy จริง");
  }

  const isAllowed = (host: string): boolean =>
    allowedHosts.has(host) || (extraHost?.() ?? null) === host;

  return new Elysia({ name: "origin-guard" }).onRequest(({ request }) => {
    // ไม่มี allowed host ที่ config ไว้ → ข้าม (ไม่บล็อกทั้งระบบเพราะ config ขาด)
    if (allowedHosts.size === 0) return;

    // health endpoint ข้ามการตรวจ Host เสมอ (ดู HEALTH_PATH) — เทียบ pathname อย่างเดียว
    // ไม่เอา query string มาเกี่ยว กัน `/other?x=/api/v1/system/health` เล็ดลอด
    const pathname = new URL(request.url).pathname;
    if (pathname === HEALTH_PATH) return;
    // terminal relay ฝั่ง worker ก็ข้ามเช่นกัน (ดู TERMINAL_RELAY_PATH_PREFIX ด้านบน)
    if (pathname.startsWith(TERMINAL_RELAY_PATH_PREFIX)) return;

    // HTTP/1.1 บังคับให้ client ส่ง Host header เสมอ — ไม่มีค่าได้เฉพาะ request ที่สร้างในหน่วยความจำ
    // ตรง ๆ (เช่นในเทสต์ที่เรียก app.handle() โดยไม่ผ่าน socket จริง) จึงข้ามแทนที่จะ throw
    const hostHeader = request.headers.get("host");
    if (hostHeader) {
      const requestHost = hostOf(hostHeader);
      if (!requestHost || !isAllowed(requestHost)) {
        throw new AppError("INVALID_HOST", "Host header ไม่ถูกต้องหรือไม่ได้รับอนุญาต");
      }
    }

    if (!MUTATING_METHODS.has(request.method)) return;

    // Origin header ไม่มีเสมอไป (เช่น same-origin GET, บาง client เก่า) — เช็คเฉพาะเมื่อมีค่า
    const origin = request.headers.get("origin");
    if (!origin) return;
    const originHost = hostOf(origin);
    if (!originHost || !isAllowed(originHost)) {
      throw new AppError("INVALID_ORIGIN", "Origin ของ request ไม่ได้รับอนุญาต");
    }
  });
}
