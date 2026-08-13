/**
 * Interactive terminal — WebSocket relay routes
 * Phase 17
 *
 * bun test รองรับ Bun native WebSocket client จริง ๆ (รับ header กำหนดเองได้ผ่าน
 * `new WebSocket(url, { headers })`) จึงเปิด server จริงด้วย `app.listen(0)` (ephemeral port)
 * แทนที่จะใช้ `app.handle()` แบบเทสต์ HTTP route ปกติ — WS upgrade ต้องผ่าน socket จริงเท่านั้น
 * (`app.handle()` ใช้ได้แค่เคส "ปฏิเสธก่อน upgrade" เช่น 401 unauthenticated เพราะ beforeHandle
 * throw ก่อนถึงบรรทัด server.upgrade() เสมอ)
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { resetInternalTokenCache } from "../src/crypto/internal-token";
import type { TerminalRouteOptions } from "../src/routes/terminal";
import {
  createPendingSession,
  markSessionClosed,
  requireSession,
} from "../src/services/terminal-store";
import { json } from "./helpers";

const VALID_TOKEN = "test-internal-token-0123456789abcdef";

function setInternalToken(token: string | null): void {
  resetInternalTokenCache();
  if (token === null) {
    process.env.ZIXPLOY_INTERNAL_TOKEN_FILE = "";
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "zx-internal-token-"));
  const file = join(dir, "token");
  writeFileSync(file, token);
  process.env.ZIXPLOY_INTERNAL_TOKEN_FILE = file;
}

async function setup(routeOptions?: TerminalRouteOptions) {
  setInternalToken(VALID_TOKEN);

  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));

  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)",
  ).run(ulid(), await hashPassword("adminpass123"), now, now);

  const serviceId = ulid();
  db.query(
    `INSERT INTO services
      (id, name, type, version, image, status, container_id, volume_name,
       username, database_name, internal_port, created_at, updated_at)
     VALUES (?, 'db1', 'postgres', '16', 'postgres:16', 'running', 'c1', 'zxsvcvol-x',
             'app', 'app', 5432, ?, ?)`,
  ).run(serviceId, now, now);

  // ค่า default ยาวพอที่จะไม่มีทางยิงกลางเทสต์ปกติโดยไม่ได้ตั้งใจ (เทสต์ timeout เฉพาะจุดจะ
  // override เป็นค่าสั้นเอง) — ป้องกัน timer ค้างทำให้ `bun test` แขวนหลังเทสต์จบ
  const app = buildApp(db, {
    terminal: { browserWaitTimeoutMs: 60_000, idleTimeoutMs: 60_000, ...routeOptions },
  });

  const loginRes = await app.handle(
    new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "adminpass123" }),
    }),
  );
  const cookies: Record<string, string> = {};
  for (const raw of loginRes.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (pair && eq > 0) cookies[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");

  app.listen(0);
  const port = (app.server as { port: number }).port;

  return { db, app, cookie, serviceId, port };
}

type App = Awaited<ReturnType<typeof setup>>["app"];

/**
 * `app.stop()` (Bun `Server.stop()`) แขวนไม่คืนค่าเลยถ้า process เคยมี WebSocket connection
 * ที่ upgrade แล้วผ่านมันมาก่อน — reproduce ได้แน่นอนบน bun test v1.3.5/Windows ในสภาพแวดล้อมนี้
 * (ยืนยันด้วย repro ขั้นต่ำสุด: .ws() handler เปล่า ๆ ปิดทันทีที่ open ก็ยังแขวนที่ app.stop(true)
 * แม้ตัว WS round-trip เองจะเสร็จสมบูรณ์แล้วก็ตาม — ไม่ใช่บั๊กของโค้ด route เรา) จึง race กับ
 * timeout สั้น ๆ แทนที่จะ await ตรง ๆ ไม่งั้นทั้ง suite จะแขวนทดสอบไม่จบ — เทสต์แต่ละตัวใช้
 * ephemeral port คนละอันอยู่แล้วจึงไม่ชนกัน และ process ของ `bun test` เองไม่รอ listener ที่ยัง
 * ไม่ปิดตอนจบ suite (ยืนยันแล้วเช่นกัน)
 */
async function teardown(app: App, ...sockets: (WebSocket | null | undefined)[]): Promise<void> {
  for (const s of sockets) {
    try {
      s?.close();
    } catch {
      // เพิกเฉย — อาจปิดไปแล้ว
    }
  }
  await Promise.race([
    app.stop(true).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 200)),
  ]);
}

function browserWsUrl(port: number, serviceId: string): string {
  return `ws://localhost:${port}/api/v1/services/${serviceId}/terminal`;
}

function workerWsUrl(port: number, sessionId: string): string {
  return `ws://localhost:${port}/internal/terminal-relay/${sessionId}`;
}

function onceOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws error event")), { once: true });
  });
}

function onceClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.addEventListener(
      "close",
      (ev) => {
        const e = ev as CloseEvent;
        resolve({ code: e.code, reason: e.reason });
      },
      { once: true },
    );
  });
}

function onceMessage(ws: WebSocket): Promise<MessageEvent> {
  return new Promise((resolve) => {
    ws.addEventListener("message", (ev) => resolve(ev as MessageEvent), { once: true });
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);
}

function sessionRowFor(db: Database, serviceId: string): { id: string; status: string } | null {
  return db
    .query<{ id: string; status: string }, [string]>(
      "SELECT id, status FROM terminal_sessions WHERE service_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(serviceId);
}

// ---------------------------------------------------------------------------

describe("terminal-store", () => {
  test("createPendingSession — สร้างแถว pending, โยน SERVICE_NOT_FOUND ถ้า service ไม่มีจริง", async () => {
    const { app, db, serviceId } = await setup();
    try {
      const { id } = createPendingSession(db, serviceId);
      const row = requireSession(db, id);
      expect(row.status).toBe("pending");
      expect(row.service_id).toBe(serviceId);

      expect(() => createPendingSession(db, ulid())).toThrow();
    } finally {
      await teardown(app);
    }
  });

  test("requireSession — โยน TERMINAL_SESSION_NOT_FOUND ถ้าไม่พบ", async () => {
    const { app, db } = await setup();
    try {
      expect(() => requireSession(db, ulid())).toThrow();
      try {
        requireSession(db, ulid());
      } catch (err) {
        expect((err as { code?: string }).code).toBe("TERMINAL_SESSION_NOT_FOUND");
      }
    } finally {
      await teardown(app);
    }
  });

  test("markSessionClosed — ไม่ให้ failureMessage = closed, ให้ = failed", async () => {
    const { app, db, serviceId } = await setup();
    try {
      const { id: id1 } = createPendingSession(db, serviceId);
      markSessionClosed(db, id1);
      expect(requireSession(db, id1).status).toBe("closed");

      const { id: id2 } = createPendingSession(db, serviceId);
      markSessionClosed(db, id2, { failureMessage: "boom" });
      const row2 = requireSession(db, id2);
      expect(row2.status).toBe("failed");
      expect(row2.failure_message).toBe("boom");
    } finally {
      await teardown(app);
    }
  });
});

describe("GET /services/:id/terminal — browser WS", () => {
  test("ไม่ login → ปฏิเสธก่อน upgrade เหมือน 401 ปกติ", async () => {
    const { app, serviceId } = await setup();
    try {
      // ต้องแนบ header ของ WS upgrade เอง — router ของ Elysia จับคู่ path ที่ลงทะเบียนด้วย
      // .ws() เฉพาะตอนเห็น Upgrade: websocket เท่านั้น ไม่งั้นตกไป NOT_FOUND (404) แทนที่จะเข้า
      // beforeHandle เหมือน route ปกติ (ยืนยันจริงจากพฤติกรรม Elysia 1.4 ไม่ได้เดา)
      const res = await app.handle(
        new Request(`http://localhost/api/v1/services/${serviceId}/terminal`, {
          headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
          },
        }),
      );
      expect(res.status).toBe(401);
      expect((await json(res)).error.code).toBe("UNAUTHENTICATED");
    } finally {
      await teardown(app);
    }
  });

  test("login แล้วแต่ service ไม่มีจริง → WS ปิดด้วย close code ไม่ใช่ 1000 และไม่มีแถวค้าง", async () => {
    const { app, db, cookie, port } = await setup();
    let ws: WebSocket | undefined;
    try {
      ws = new WebSocket(browserWsUrl(port, ulid()), { headers: { Cookie: cookie } });
      const closeEvent = await withTimeout(onceClose(ws), 3000, "close ของ bogus service");
      expect(closeEvent.code).not.toBe(1000);

      const count = db
        .query<{ c: number }, []>("SELECT COUNT(*) as c FROM terminal_sessions")
        .get();
      expect(count?.c ?? 0).toBe(0);
    } finally {
      await teardown(app, ws);
    }
  });

  test("login + internal token ไม่ได้ตั้งค่า → ปิดด้วยเหตุผล unavailable ไม่สร้างแถว", async () => {
    const { app, db, cookie, serviceId, port } = await setup();
    setInternalToken(null);
    let ws: WebSocket | undefined;
    try {
      ws = new WebSocket(browserWsUrl(port, serviceId), { headers: { Cookie: cookie } });
      const closeEvent = await withTimeout(onceClose(ws), 3000, "close เพราะ token ไม่ตั้งค่า");
      expect(closeEvent.code).toBe(4003);

      const row = sessionRowFor(db, serviceId);
      expect(row).toBeNull();
    } finally {
      await teardown(app, ws);
      setInternalToken(VALID_TOKEN);
    }
  });

  test("login + service มีจริง → สร้างแถว pending", async () => {
    const { app, db, cookie, serviceId, port } = await setup();
    let ws: WebSocket | undefined;
    try {
      ws = new WebSocket(browserWsUrl(port, serviceId), { headers: { Cookie: cookie } });
      await withTimeout(onceOpen(ws), 3000, "browser ws open");
      // รอสั้น ๆ ให้ handler ฝั่ง server insert แถวเสร็จ (open() ทำงานก่อน onopen ฝั่ง client เล็กน้อย
      // แต่กันไว้เผื่อ race)
      await new Promise((r) => setTimeout(r, 50));

      const row = sessionRowFor(db, serviceId);
      expect(row).not.toBeNull();
      expect(row?.status).toBe("pending");
    } finally {
      await teardown(app, ws);
    }
  });

  test("worker ไม่มาต่อภายในเวลา → ปิด browser ws และ mark failed", async () => {
    const { app, db, cookie, serviceId, port } = await setup({ browserWaitTimeoutMs: 80 });
    let ws: WebSocket | undefined;
    try {
      ws = new WebSocket(browserWsUrl(port, serviceId), { headers: { Cookie: cookie } });
      const closeEvent = await withTimeout(onceClose(ws), 3000, "close เพราะ worker unavailable");
      expect(closeEvent.code).toBe(4008);

      const row = sessionRowFor(db, serviceId);
      expect(row?.status).toBe("failed");
    } finally {
      await teardown(app, ws);
    }
  });
});

describe("GET /internal/terminal-relay/:sessionId — worker WS", () => {
  test("bearer token ผิด/ไม่มี → ปฏิเสธการเชื่อมต่อ", async () => {
    const { app, port } = await setup();
    let wsNoAuth: WebSocket | undefined;
    let wsWrongAuth: WebSocket | undefined;
    try {
      wsNoAuth = new WebSocket(workerWsUrl(port, ulid()));
      const closeNoAuth = await withTimeout(onceClose(wsNoAuth), 3000, "close ไม่มี token");
      expect(closeNoAuth.code).toBe(4001);

      wsWrongAuth = new WebSocket(workerWsUrl(port, ulid()), {
        headers: { Authorization: "Bearer wrong-token-entirely" },
      });
      const closeWrongAuth = await withTimeout(onceClose(wsWrongAuth), 3000, "close token ผิด");
      expect(closeWrongAuth.code).toBe(4001);
    } finally {
      await teardown(app, wsNoAuth, wsWrongAuth);
    }
  });

  test("token ถูกต้องแต่ sessionId ไม่รู้จัก/ไม่ได้ pending อยู่ → ปฏิเสธ", async () => {
    const { app, port } = await setup();
    let ws: WebSocket | undefined;
    try {
      ws = new WebSocket(workerWsUrl(port, ulid()), {
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
      });
      const closeEvent = await withTimeout(onceClose(ws), 3000, "close sessionId ไม่รู้จัก");
      expect(closeEvent.code).toBe(4004);
    } finally {
      await teardown(app, ws);
    }
  });
});

describe("relay end-to-end — browser <-> worker", () => {
  test("happy path: ต่อครบสองฝั่ง, relay binary + text frame ได้สองทาง, ปิดฝั่งหนึ่งปิดอีกฝั่งด้วย และ DB ปิดสถานะ", async () => {
    const { app, db, cookie, serviceId, port } = await setup();
    let browserWs: WebSocket | undefined;
    let workerWs: WebSocket | undefined;
    try {
      browserWs = new WebSocket(browserWsUrl(port, serviceId), { headers: { Cookie: cookie } });
      browserWs.binaryType = "arraybuffer";
      await withTimeout(onceOpen(browserWs), 3000, "browser open");

      const row = sessionRowFor(db, serviceId);
      expect(row).not.toBeNull();
      const sessionId = row?.id as string;

      workerWs = new WebSocket(workerWsUrl(port, sessionId), {
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
      });
      workerWs.binaryType = "arraybuffer";
      await withTimeout(onceOpen(workerWs), 3000, "worker open");

      // binary frame: browser -> worker (จำลอง keystroke ดิบ)
      const keystroke = new Uint8Array([0x6c, 0x73, 0x0d]); // "ls\r"
      const workerGotBinary = onceMessage(workerWs);
      browserWs.send(keystroke);
      const binMsg = await withTimeout(workerGotBinary, 3000, "worker รับ binary");
      expect(new Uint8Array(binMsg.data as ArrayBuffer)).toEqual(keystroke);

      // binary frame: worker -> browser (จำลอง stdout)
      const stdout = new Uint8Array([0x68, 0x69]); // "hi"
      const browserGotBinary = onceMessage(browserWs);
      workerWs.send(stdout);
      const binMsg2 = await withTimeout(browserGotBinary, 3000, "browser รับ binary");
      expect(new Uint8Array(binMsg2.data as ArrayBuffer)).toEqual(stdout);

      // text/JSON control frame: browser -> worker (resize)
      const control = { type: "resize", cols: 80, rows: 24 };
      const workerGotText = onceMessage(workerWs);
      browserWs.send(JSON.stringify(control));
      const textMsg = await withTimeout(workerGotText, 3000, "worker รับ control frame");
      expect(typeof textMsg.data).toBe("string");
      expect(JSON.parse(textMsg.data as string)).toEqual(control);

      // ปิดฝั่ง worker → browser ต้องถูกปิดตามไปด้วย + DB ปิดสถานะ
      const browserClosed = onceClose(browserWs);
      workerWs.close(1000, "worker done");
      const closeEvent = await withTimeout(browserClosed, 3000, "browser ปิดตามหลัง worker");
      expect(closeEvent.code).not.toBe(0);

      await new Promise((r) => setTimeout(r, 50));
      const finalRow = db
        .query<{ status: string }, [string]>("SELECT status FROM terminal_sessions WHERE id = ?")
        .get(sessionId);
      expect(finalRow?.status).toBe("closed");
    } finally {
      await teardown(app, browserWs, workerWs);
    }
  });

  test("idle timeout: ไม่มีข้อความไหลผ่านเลย → ปิดทั้งคู่อัตโนมัติและ mark closed", async () => {
    const { app, db, cookie, serviceId, port } = await setup({
      browserWaitTimeoutMs: 60_000,
      idleTimeoutMs: 80,
    });
    let browserWs: WebSocket | undefined;
    let workerWs: WebSocket | undefined;
    try {
      browserWs = new WebSocket(browserWsUrl(port, serviceId), { headers: { Cookie: cookie } });
      await withTimeout(onceOpen(browserWs), 3000, "browser open");

      const row = sessionRowFor(db, serviceId);
      const sessionId = row?.id as string;

      workerWs = new WebSocket(workerWsUrl(port, sessionId), {
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
      });
      const workerOpened = onceOpen(workerWs);
      const browserClosedByIdle = onceClose(browserWs);
      await withTimeout(workerOpened, 3000, "worker open");

      // ไม่ส่งอะไรเลยหลังจากนี้ — รอ idle timeout (80ms) ทำงาน
      const closeEvent = await withTimeout(browserClosedByIdle, 3000, "ปิดเพราะ idle timeout");
      expect(closeEvent.code).toBe(4009);

      await new Promise((r) => setTimeout(r, 50));
      const finalRow = db
        .query<{ status: string }, [string]>("SELECT status FROM terminal_sessions WHERE id = ?")
        .get(sessionId);
      expect(finalRow?.status).toBe("closed");
    } finally {
      await teardown(app, browserWs, workerWs);
    }
  });
});
