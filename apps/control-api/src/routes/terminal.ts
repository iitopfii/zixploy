/**
 * Interactive Terminal Routes — Phase 17
 *
 *   GET /api/v1/services/:id/terminal          — browser ต่อ WebSocket มาที่นี่ (ต้อง login)
 *   GET /internal/terminal-relay/:sessionId     — worker ต่อ WebSocket มาที่นี่ (bearer token)
 *
 * ADR-0002: control-api ไม่แตะ Docker เลย — endpoint พวกนี้ไม่รู้จัก `docker exec` ด้วยซ้ำ
 * มันแค่ถือ WebSocket สองเส้น (browser กับ worker) แล้ว relay byte ดิบระหว่างกันเท่านั้น
 * (สถาปัตยกรรมเต็ม ๆ + message framing ดู comment เหนือ TERMINAL_SETTINGS ใน
 * internal/shared/src/constants.ts)
 *
 * deploy-worker ไม่มี server ของตัวเอง จึง poll ตาราง terminal_sessions หา pending session
 * แล้วต่อ WebSocket แบบ CLIENT กลับมาหา control-api เอง ผ่าน zixploy-internal network ตรง ๆ
 * (container DNS, ไม่ผ่าน Traefik) route ฝั่ง worker จึงต้องอยู่ "นอก" ${API_PREFIX} โดยตั้งใจ —
 * Traefik รู้จักแค่ PathPrefix('/api/') เท่านั้น route ที่ /internal/* จึงไม่มีทางถูกยิงมาจาก
 * internet ได้เลยแม้แต่จะลอง (defense-in-depth ชั้นที่สอง ต่อจาก bearer token) ดู
 * origin-guard.ts สำหรับข้อยกเว้น Host check ของ path นี้ (เหตุผลเดียวกับ HEALTH_PATH)
 *
 * ห้ามรวม route สองกลุ่มนี้เข้า Elysia instance เดียวกัน/guard เดียวกันเด็ดขาด — กลุ่ม browser
 * ต้อง login ผ่าน session cookie ปกติ ส่วนกลุ่ม worker ยืนยันตัวด้วย internal bearer token
 * คนละกลไกกันโดยสิ้นเชิง
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, TERMINAL_SETTINGS } from "@zixploy/shared";
import { Elysia } from "elysia";
import { isValidInternalToken, loadInternalToken } from "../crypto/internal-token";
import { authPlugin, requireAuthenticated } from "../plugins/auth";
import { requireService } from "../services/store";
import { createPendingSession, markSessionClosed } from "../services/terminal-store";

/**
 * path ของ route ฝั่ง worker — export ไว้ให้ origin-guard.ts อ้างอิงตรง ๆ (กันพิมพ์ผิดแยกที่)
 * ตั้งใจ**ไม่**ขึ้นต้นด้วย API_PREFIX (ดู comment บนสุดของไฟล์)
 */
export const TERMINAL_RELAY_PATH = "/internal/terminal-relay";

// ---------------------------------------------------------------------------
// In-memory relay state — เดี่ยวต่อ process (control-api ไม่ scale แนวนอน จึงพอ เหมือน
// cache ใน apps/control-api/src/updates/check.ts)
// ---------------------------------------------------------------------------

type Role = "browser" | "worker";

/** เอาแค่เมธอดที่ relay ต้องใช้ — หลีกเลี่ยง generic ของ ElysiaWS ที่ต่างกันคนละ route */
interface RelaySocket {
  send(data: unknown, compress?: boolean): unknown;
  close(code?: number, reason?: string): unknown;
}

interface RelayEntry {
  browserWs: RelaySocket | null;
  workerWs: RelaySocket | null;
  lastActivityAt: number;
  /** timer รอ worker มา claim — เคลียร์ทิ้งทันทีที่ worker ต่อสำเร็จ */
  waitTimer: ReturnType<typeof setTimeout> | null;
  /** timer idle timeout — reset ทุกครั้งที่มีข้อความไหลผ่านทั้งสองฝั่งต่อกันจริง */
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, RelayEntry>();

/** โยง raw ServerWebSocket (คงที่ตลอดอายุ connection) กลับไปหา sessionId — ElysiaWS wrapper
 *  ตัวใหม่ถูกสร้างทุก event แต่ `.raw` ตัวเดิมเสมอ จึงใช้เป็นคีย์ได้ */
const socketSession = new WeakMap<object, string>();

function safeClose(ws: RelaySocket | null, code: number, reason: string): void {
  if (!ws) return;
  try {
    ws.close(code, reason);
  } catch {
    // ปิดไปแล้ว/socket ตายไปก่อนหน้า — เพิกเฉย
  }
}

/** ปิดทั้งคู่ + mark DB + ลบออกจาก map — idempotent (เรียกซ้ำได้ปลอดภัย เพราะเช็ค map ก่อนเสมอ) */
function endSession(
  db: Database,
  sessionId: string,
  opts: { code: number; reason: string; failureMessage?: string },
): void {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  sessions.delete(sessionId);
  if (entry.waitTimer) clearTimeout(entry.waitTimer);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);

  safeClose(entry.browserWs, opts.code, opts.reason);
  safeClose(entry.workerWs, opts.code, opts.reason);

  markSessionClosed(
    db,
    sessionId,
    opts.failureMessage ? { failureMessage: opts.failureMessage } : {},
  );
}

function scheduleIdleTimeout(
  db: Database,
  sessionId: string,
  entry: RelayEntry,
  idleTimeoutMs: number,
): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    endSession(db, sessionId, {
      code: 4009,
      reason: "ปิด terminal อัตโนมัติ — ไม่มีการใช้งานนานเกินไป (idle timeout)",
    });
  }, idleTimeoutMs);
}

/**
 * relay ข้อความจากฝั่งหนึ่งไปอีกฝั่ง — แบบ raw ไม่แปลงเนื้อหา (`ws.send()` ของ Elysia เลือก
 * binary/text frame ให้เองจาก type ของ `data`: Buffer -> binary, ที่เหลือ -> text)
 * reset idle timer เฉพาะตอนที่ relay "มีชีวิต" จริง (ทั้งสองฝั่งต่ออยู่) เท่านั้น
 */
function relayMessage(
  db: Database,
  sessionId: string,
  from: Role,
  message: unknown,
  idleTimeoutMs: number,
): void {
  const entry = sessions.get(sessionId);
  if (!entry) return;

  const target = from === "browser" ? entry.workerWs : entry.browserWs;
  if (entry.browserWs && entry.workerWs) {
    entry.lastActivityAt = Date.now();
    scheduleIdleTimeout(db, sessionId, entry, idleTimeoutMs);
  }
  target?.send(message as never);
}

function bearerToken(headers: Record<string, string | undefined>): string | null {
  const raw = headers.authorization;
  if (!raw?.startsWith("Bearer ")) return null;
  const token = raw.slice("Bearer ".length).trim();
  return token || null;
}

// ---------------------------------------------------------------------------
// Route module
// ---------------------------------------------------------------------------

export interface TerminalRouteOptions {
  /** override ได้เพื่อเทสต์ — ปกติมาจาก TERMINAL_SETTINGS.browserWaitTimeoutMs */
  browserWaitTimeoutMs?: number;
  /** override ได้เพื่อเทสต์ — ปกติมาจาก TERMINAL_SETTINGS.idleTimeoutMs */
  idleTimeoutMs?: number;
}

export function terminalRoutes(db: Database, options: TerminalRouteOptions = {}) {
  const waitTimeoutMs = options.browserWaitTimeoutMs ?? TERMINAL_SETTINGS.browserWaitTimeoutMs;
  const idleTimeoutMs = options.idleTimeoutMs ?? TERMINAL_SETTINGS.idleTimeoutMs;

  // ── Route A: browser-facing ─────────────────────────────────────────────
  // อยู่ใต้ API_PREFIX + authPlugin/requireAuthenticated เหมือน route อื่นทุกตัวใน services.ts
  const browserApp = new Elysia({ prefix: API_PREFIX })
    .use(authPlugin(db))
    .guard({ beforeHandle: requireAuthenticated })
    .ws("/services/:id/terminal", {
      open(ws) {
        const serviceId = ws.data.params.id;

        // ไม่มี internal token ตั้งไว้เลย = ฟีเจอร์นี้ปิดอยู่บนเครื่องนี้ — worker ต่อไม่ได้แน่นอน
        // เช็คก่อนสร้างแถว pending เลยเพื่อไม่ให้มีแถวค้างรอ worker ที่ไม่มีทางมา
        if (!loadInternalToken()) {
          const err = new AppError(
            "TERMINAL_UNAVAILABLE",
            "ยังไม่ได้ตั้งค่า internal token บนเครื่องนี้ — terminal ใช้งานไม่ได้",
          );
          ws.close(4003, err.message);
          return;
        }

        // service ไม่มีอยู่จริง — WS เปิดไปแล้ว คืน HTTP 404 body ไม่ได้ ต้องปิดด้วย close code แทน
        try {
          requireService(db, serviceId);
        } catch (err) {
          const message = err instanceof AppError ? err.message : "ไม่พบ service นี้";
          ws.close(4004, message);
          return;
        }

        const { id: sessionId } = createPendingSession(db, serviceId);
        socketSession.set(ws.raw, sessionId);

        const entry: RelayEntry = {
          browserWs: ws,
          workerWs: null,
          lastActivityAt: Date.now(),
          waitTimer: null,
          idleTimer: null,
        };
        sessions.set(sessionId, entry);

        // worker อาจไม่มารับเลย (ไม่ได้รัน worker อยู่) — อย่าปล่อยให้ browser ค้างเงียบตลอดไป
        entry.waitTimer = setTimeout(() => {
          entry.waitTimer = null;
          if (entry.workerWs) return; // worker มาทันเวลาพอดี ไม่ต้องทำอะไร
          endSession(db, sessionId, {
            code: 4008,
            reason: "worker unavailable — deploy-worker อาจไม่ได้รันอยู่",
            failureMessage: "worker unavailable",
          });
        }, waitTimeoutMs);
      },

      message(ws, message) {
        const sessionId = socketSession.get(ws.raw);
        if (!sessionId) return;
        relayMessage(db, sessionId, "browser", message, idleTimeoutMs);
      },

      close(ws) {
        const sessionId = socketSession.get(ws.raw);
        if (!sessionId) return;
        endSession(db, sessionId, { code: 1000, reason: "browser ปิดการเชื่อมต่อ" });
      },
    });

  // ── Route B: worker-facing internal relay ───────────────────────────────
  // Elysia instance แยกต่างหาก ไม่มี prefix, ไม่มี authPlugin/guard ใด ๆ ทั้งสิ้น — auth
  // เป็น bearer token ล้วน ๆ เช็คเองใน open() (WS-close ปฏิเสธ ไม่ใช่ HTTP response เพราะจุดที่
  // เช็คได้เร็วที่สุดคือหลัง upgrade ไปแล้ว)
  const workerApp = new Elysia().ws(`${TERMINAL_RELAY_PATH}/:sessionId`, {
    open(ws) {
      const token = bearerToken(ws.data.headers);
      if (!loadInternalToken() || !isValidInternalToken(token)) {
        ws.close(4001, "internal token ไม่ถูกต้องหรือไม่ได้ตั้งค่า");
        return;
      }

      const sessionId = ws.data.params.sessionId;
      const entry = sessions.get(sessionId);
      // ไม่มี browser รอ session นี้อยู่ (timeout ไปแล้ว/sessionId มั่ว) หรือมี worker attach
      // ไปแล้วก่อนหน้า (ไม่ควรเกิดในทางปฏิบัติเพราะ worker claim แถวใน DB แบบ atomic ก่อนต่อ
      // WS มาหาเราเสมอ แต่กันไว้เผื่อ race)
      if (!entry || entry.workerWs) {
        const err = new AppError("TERMINAL_SESSION_NOT_FOUND", "ไม่พบ terminal session ที่รออยู่");
        ws.close(4004, err.message);
        return;
      }

      if (entry.waitTimer) {
        clearTimeout(entry.waitTimer);
        entry.waitTimer = null;
      }

      entry.workerWs = ws;
      socketSession.set(ws.raw, sessionId);
      scheduleIdleTimeout(db, sessionId, entry, idleTimeoutMs);
    },

    message(ws, message) {
      const sessionId = socketSession.get(ws.raw);
      if (!sessionId) return;
      relayMessage(db, sessionId, "worker", message, idleTimeoutMs);
    },

    close(ws) {
      const sessionId = socketSession.get(ws.raw);
      if (!sessionId) return;
      endSession(db, sessionId, { code: 1000, reason: "worker ปิดการเชื่อมต่อ" });
    },
  });

  return new Elysia().use(browserApp).use(workerApp);
}
