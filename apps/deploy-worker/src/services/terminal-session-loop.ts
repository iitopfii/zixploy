/**
 * Interactive terminal session loop — Phase 17
 *
 * worker เท่านั้นที่แตะ Docker (ADR-0002) — control-api สร้างแถว terminal_sessions
 * (status='pending') เมื่อ browser เปิด web terminal เข้า managed service แล้วรอ worker มา
 * claim/ต่อ WebSocket เอง ตารางนี้เป็นแค่ "กระดานงาน" ไม่เคยเก็บเนื้อหา terminal เลย — I/O ไหล
 * สด ๆ ผ่าน WebSocket relay ที่ worker เปิดออกไปหา control-api ตรง ๆ (ดู comment เหนือ
 * TERMINAL_SETTINGS ใน internal/shared/src/constants.ts สำหรับสถาปัตยกรรมเต็ม + message framing)
 *
 * poll ถี่กว่า loop อื่นมาก (ทุก 1 วิ) เพราะผู้ใช้รอเปิด terminal อยู่สด ๆ หน้าจอ — ต่างจาก
 * backupScheduleLoop/metricsLoop ที่ไม่มีใครรอผล
 *
 * ไม่ทำงานทีละ session (ไม่เหมือน backup ที่ตั้งใจ serialize กันแย่ง Docker I/O) — session หนึ่ง
 * อาจมีชีวิตอยู่นาน (จนกว่าผู้ใช้ปิดเองหรือ idle timeout 30 นาที) ถ้า block loop รอ session เดียว
 * จนจบ จะเปิด terminal ไป service อื่นพร้อมกันไม่ได้เลย — claim แล้วปล่อยให้ handleSession ทำงาน
 * เป็น background task ของมันเอง แล้ว loop กลับไป poll หา pending row ถัดไปทันที
 */

import type { Database } from "bun:sqlite";
import {
  type ServiceType,
  serviceContainerName,
  TERMINAL_SETTINGS,
  terminalShellFor,
} from "@zixploy/shared";
import type { DockerCliClient } from "../docker/cli-client";
import { loadInternalToken } from "../internal-token";
import { loadService } from "./provision";

// ---------------------------------------------------------------------------
// WebSocket client abstraction — injectable เพื่อเทสต์ได้โดยไม่ต้องมี control-api จริง
// ---------------------------------------------------------------------------

/** subset ของ WebSocket client ที่โค้ดนี้ใช้จริง — Bun's native `WebSocket` ตรงตาม shape นี้พอดี */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string | ArrayBuffer | Uint8Array }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
}

/** OPEN readyState ตาม WebSocket spec (ค่าเดียวกันทั้ง browser และ Bun) */
const WS_OPEN = 1;

export type ConnectFn = (url: string, headers: Record<string, string>) => WebSocketLike;

/**
 * default connect — ใช้ Bun's native `WebSocket` (global, ไม่ต้อง import) ส่ง Authorization
 * header ตรงบน handshake เอง — ยืนยันแล้วว่า Bun 1.3.5 รองรับ `headers` ใน constructor options
 * จริง (ทดสอบ round-trip กับ Bun.serve local จริง เห็น header มาถึงฝั่ง server) จึง**ไม่ต้อง
 * fallback ไปส่ง token ผ่าน query string** — ฝั่ง control-api อ่าน Authorization header ได้เลย
 */
function defaultConnect(url: string, headers: Record<string, string>): WebSocketLike {
  const ws = new WebSocket(url, { headers });
  ws.binaryType = "arraybuffer";
  return ws as unknown as WebSocketLike;
}

// ---------------------------------------------------------------------------
// DB access
// ---------------------------------------------------------------------------

export interface TerminalSessionRow {
  id: string;
  service_id: string;
  status: string;
  failure_message: string | null;
  created_at: number;
  claimed_at: number | null;
  closed_at: number | null;
}

/**
 * atomic claim: SELECT candidate แล้ว UPDATE...WHERE status='pending' ในธุรกรรมเดียว —
 * changes=0 หมายถึงมีคน claim ไปพร้อมกัน (สอง loop iteration ชนกัน หรือ worker หลาย instance)
 * ปล่อยให้ caller ข้ามไป poll รอบถัดไปเฉย ๆ ไม่ throw
 *
 * export ไว้ให้เทสต์เรียกตรง ๆ ได้ (พิสูจน์ atomicity โดยไม่ต้องพึ่ง timing ของ loop เต็ม —
 * รูปแบบเดียวกับ claimNextJob ใน queue.ts)
 */
export function claimNextPendingSession(db: Database): TerminalSessionRow | null {
  return db.transaction((): TerminalSessionRow | null => {
    const candidate = db
      .query<{ id: string }, []>(
        "SELECT id FROM terminal_sessions WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1",
      )
      .get();
    if (!candidate) return null;

    const now = Date.now();
    const result = db
      .query(
        "UPDATE terminal_sessions SET status = 'active', claimed_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(now, candidate.id);
    if ((result.changes ?? 0) === 0) return null;

    return (
      db
        .query<TerminalSessionRow, [string]>(
          `SELECT id, service_id, status, failure_message, created_at, claimed_at, closed_at
           FROM terminal_sessions WHERE id = ?`,
        )
        .get(candidate.id) ?? null
    );
  })();
}

function truncate(text: string, max = 500): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function markFailed(db: Database, id: string, message: string): void {
  db.query(
    "UPDATE terminal_sessions SET status = 'failed', failure_message = ?, closed_at = ? WHERE id = ?",
  ).run(truncate(message), Date.now(), id);
}

function markClosed(db: Database, id: string): void {
  db.query("UPDATE terminal_sessions SET status = 'closed', closed_at = ? WHERE id = ?").run(
    Date.now(),
    id,
  );
}

// ---------------------------------------------------------------------------
// Connect + wait for open/failure
// ---------------------------------------------------------------------------

function extractErrorMessage(event: unknown): string {
  if (event && typeof event === "object" && "message" in event) {
    const msg = (event as { message?: unknown }).message;
    if (typeof msg === "string" && msg) return msg;
  }
  return "เชื่อมต่อ control-api ไม่สำเร็จ";
}

type ConnectOutcome = { ok: true; ws: WebSocketLike } | { ok: false; reason: string };

/**
 * ต่อ WebSocket แล้วรอจนกว่าจะ open สำเร็จหรือล้มเหลว (error/close/timeout) — WebSocket
 * constructor เป็น async โดยธรรมชาติ ไม่มีทาง await ตรง ๆ ต้องห่อด้วย Promise เอง
 *
 * timeoutMs ใช้ TERMINAL_SETTINGS.browserWaitTimeoutMs เป็นค่าเริ่มต้น (เวลาเดียวกับที่
 * control-api ยอมรอ worker มา claim+connect ก่อนจะปิด connection ฝั่ง browser เอง) — รอนานกว่า
 * นั้นไปก็ไม่มีประโยชน์เพราะฝั่ง browser คงถูกปิดไปแล้ว
 */
function connectAndWaitOpen(
  connect: ConnectFn,
  url: string,
  token: string,
  timeoutMs: number,
): Promise<ConnectOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const ws = connect(url, { Authorization: `Bearer ${token}` });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // เชื่อมต่อไม่สำเร็จอยู่แล้ว — close อาจ throw ถ้า state ไม่พร้อม ไม่สำคัญ
      }
      resolve({ ok: false, reason: `เชื่อมต่อ control-api ไม่สำเร็จภายใน ${timeoutMs}ms` });
    }, timeoutMs);

    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: true, ws });
    };
    ws.onerror = (event) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: extractErrorMessage(event) });
    };
    ws.onclose = (event) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: `control-api ปิด connection ก่อนเปิดสำเร็จ (code=${event.code})` });
    };
  });
}

// ---------------------------------------------------------------------------
// Session handling — spawn docker exec, pipe ทั้งสองทิศทาง, idle timeout, cleanup
// ---------------------------------------------------------------------------

type ExecProcess = ReturnType<DockerCliClient["execInteractive"]>;

async function pumpOutput(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void,
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.byteLength > 0) onChunk(value);
    }
  } catch {
    // stream ถูกปิดกลางทาง (process ถูก kill) — จบเงียบ ๆ ไม่ใช่ error ที่ต้อง surface
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ไม่สำคัญถ้า release ไม่ได้ (stream อาจถูก cancel ไปแล้ว)
    }
  }
}

function writeStdin(proc: ExecProcess, data: ArrayBuffer | Uint8Array): void {
  try {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    proc.stdin.write(bytes);
    proc.stdin.flush();
  } catch {
    // process อาจปิด stdin ไปแล้ว (shell กำลัง exit) — ไม่ critical ต่อการปิด session
  }
}

export interface TerminalLoopOptions {
  onLog?: (line: string) => void;
  /** DI สำหรับเทสต์ — default คือ Bun's native WebSocket จริง */
  connect?: ConnectFn;
  /** override สำหรับเทสต์ — ปกติใช้ TERMINAL_SETTINGS.idleTimeoutMs (30 นาที รอจริงในเทสต์ไม่ได้) */
  idleTimeoutMs?: number;
  /** ความถี่เช็ค idle — ปกติพอทุก 5 วิ (idle window อยู่ระดับนาที) เทสต์ override ให้ถี่ขึ้นได้ */
  idleCheckIntervalMs?: number;
  /** override เวลารอ connect สำเร็จ — ปกติใช้ TERMINAL_SETTINGS.browserWaitTimeoutMs */
  connectTimeoutMs?: number;
  /**
   * รอ resize message แรกจาก browser นานสุดเท่านี้ก่อน spawn shell เพื่อตั้งขนาด PTY ให้ตรงจอจริง
   * (browser ส่ง resize ทันทีตอน open) — เทสต์ตั้ง 0 เพื่อข้าม (spawn ทันทีด้วยขนาด default)
   */
  initialSizeWaitMs?: number;
}

interface ResolvedOptions {
  onLog: (line: string) => void;
  connect: ConnectFn;
  idleTimeoutMs: number;
  idleCheckIntervalMs: number;
  connectTimeoutMs: number;
  initialSizeWaitMs: number;
}

interface TerminalSize {
  cols: number;
  rows: number;
}

/** parse resize control frame จาก browser — คืน null ถ้าไม่ใช่ resize หรือค่าเพี้ยน */
function parseResize(text: string): TerminalSize | null {
  try {
    const msg = JSON.parse(text) as { type?: unknown; cols?: unknown; rows?: unknown };
    if (
      msg.type === "resize" &&
      Number.isInteger(msg.cols) &&
      Number.isInteger(msg.rows) &&
      (msg.cols as number) > 0 &&
      (msg.rows as number) > 0 &&
      (msg.cols as number) <= 1000 &&
      (msg.rows as number) <= 1000
    ) {
      return { cols: msg.cols as number, rows: msg.rows as number };
    }
  } catch {
    // ไม่ใช่ JSON — เมิน
  }
  return null;
}

/**
 * รอ resize message แรกจาก browser (ส่งทันทีตอน open) เพื่อเอาขนาดจอจริงไปตั้ง PTY — คืน null
 * ถ้า timeout หรือ wait=0 (ใช้ขนาด default แทน) keystroke ที่มาช่วงนี้ถูกทิ้ง: ผู้ใช้ยังไม่เห็น
 * terminal (shell ยังไม่ spawn) จึงยังไม่มีอะไรให้พิมพ์จริง — ยอมทิ้งได้ ไม่ต้อง buffer
 */
function waitForFirstResize(ws: WebSocketLike, timeoutMs: number): Promise<TerminalSize | null> {
  if (timeoutMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: TerminalSize | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        const size = parseResize(event.data);
        if (size) finish(size);
      }
    };
  });
}

/**
 * จัดการ session เดียวตั้งแต่ต่อ WebSocket จนปิด — resolve เมื่อ session จบไม่ว่าจากสาเหตุใด
 * (WS ปิด, process จบเอง, idle timeout, หรือ worker กำลัง shutdown)
 */
async function handleSession(
  db: Database,
  docker: DockerCliClient,
  controlApiUrl: string,
  row: TerminalSessionRow,
  signal: AbortSignal,
  opts: ResolvedOptions,
): Promise<void> {
  const { onLog } = opts;

  const fail = (reason: string) => {
    onLog(`terminal session ${row.id} ล้มเหลว: ${reason}`);
    markFailed(db, row.id, reason);
  };

  const token = loadInternalToken();
  if (!token) {
    fail("worker ไม่มี internal token — ตั้ง ZIXPLOY_INTERNAL_TOKEN_FILE ให้ตรงกับ control-api");
    return;
  }

  const service = loadService(db, row.service_id);
  if (!service) {
    fail("ไม่พบ service ที่ผูกกับ terminal session นี้");
    return;
  }

  // libsql (distroless) ไม่มี shell — ปฏิเสธก่อน exec เพื่อไม่ให้ผู้ใช้เจอ OCI error งง ๆ
  // (control-api ก็กันชั้นหนึ่งแล้ว แต่กันซ้ำเผื่อ session ถูกสร้างทางอื่น)
  const shell = terminalShellFor(service.type as ServiceType);
  if (!shell) {
    fail(`engine "${service.type}" ไม่มี shell ให้เปิด terminal (image เป็น distroless)`);
    return;
  }

  const containerName = serviceContainerName(row.service_id);
  const wsUrl = `${toWebSocketUrl(controlApiUrl)}/internal/terminal-relay/${row.id}`;

  const connectResult = await connectAndWaitOpen(opts.connect, wsUrl, token, opts.connectTimeoutMs);
  if (!connectResult.ok) {
    fail(connectResult.reason);
    return;
  }
  const ws = connectResult.ws;
  onLog(`terminal session ${row.id} ต่อ control-api สำเร็จ — exec เข้า ${containerName}`);

  // รอ resize แรกจาก browser เพื่อตั้งขนาด PTY ให้ตรงจอจริง (ถ้าไม่มาใน timeout ใช้ default)
  const size = await waitForFirstResize(ws, opts.initialSizeWaitMs);

  let proc: ExecProcess;
  try {
    proc = docker.execInteractive(containerName, shell, {
      sessionMarker: row.id,
      ...(size ? { cols: size.cols, rows: size.rows } : {}),
    });
  } catch (err) {
    // execInteractive throw (validation/spawn) หลัง ws เปิดแล้ว — ปิด ws ไม่ให้รั่ว
    try {
      ws.close();
    } catch {
      // ws อาจปิดไปแล้ว
    }
    fail(err instanceof Error ? err.message : String(err));
    return;
  }

  let lastActivity = Date.now();
  let closing = false;

  await new Promise<void>((resolveSession) => {
    function onAbort() {
      void finish("shutdown");
    }

    const idleTimer = setInterval(() => {
      if (Date.now() - lastActivity >= opts.idleTimeoutMs) void finish("idle");
    }, opts.idleCheckIntervalMs);

    async function finish(reason: string): Promise<void> {
      if (closing) return;
      closing = true;
      clearInterval(idleTimer);
      signal.removeEventListener("abort", onAbort);
      // reap shell ที่ค้างในคอนเทนเนอร์ก่อน — docker exec -it ทิ้งไว้เมื่อ client ตาย และ interactive
      // shell ignore SIGTERM (ต้อง kill -9 ตาม marker) ถ้าไม่ทำ shell สะสมชน --pids-limit จน DB ล่ม
      // await ก่อน resolve เพื่อให้ worker shutdown (Promise.allSettled) รอ reap เสร็จจริง
      await docker.reapTerminalShell(containerName, row.id);
      try {
        if (!proc.killed) proc.kill();
      } catch {
        // ไม่สำคัญถ้า kill ไม่สำเร็จ (process อาจจบไปแล้ว)
      }
      try {
        if (ws.readyState === WS_OPEN) ws.close();
      } catch {
        // ไม่สำคัญถ้า close ไม่สำเร็จ (ws อาจปิดไปแล้ว)
      }
      markClosed(db, row.id);
      onLog(`terminal session ${row.id} ปิดแล้ว (${reason})`);
      resolveSession();
    }

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      void finish("shutdown");
      return;
    }

    ws.onmessage = (event) => {
      lastActivity = Date.now();
      if (typeof event.data === "string") {
        // text frame = JSON control message (ปัจจุบันมีแค่ resize) — PTY มีจริงแล้ว (ผ่าน script)
        // แต่ resize สด ๆ ยัง no-op: การเปลี่ยนขนาด PTY ต้อง ioctl TIOCSWINSZ บน master fd ซึ่ง
        // Bun ไม่เปิดให้ทำง่าย ๆ ขนาดถูกตั้งครั้งเดียวตอนเปิด (ดู DockerCliClient.execInteractive)
        return;
      }
      writeStdin(proc, event.data);
    };
    ws.onerror = () => {
      // onclose จะตามมาเสมอหลัง onerror ตาม WebSocket spec — ปล่อยให้ onclose เป็นคน finish
      onLog(`terminal session ${row.id} เจอ WebSocket error`);
    };
    ws.onclose = () => void finish("ws-closed");

    void pumpOutput(proc.stdout, (chunk) => {
      lastActivity = Date.now();
      if (ws.readyState === WS_OPEN) ws.send(chunk);
    });
    void pumpOutput(proc.stderr, (chunk) => {
      lastActivity = Date.now();
      if (ws.readyState === WS_OPEN) ws.send(chunk);
    });

    void proc.exited.then(() => void finish("process-exit"));
  });
}

function toWebSocketUrl(httpUrl: string): string {
  const trimmed = httpUrl.replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  return trimmed; // สมมติว่าเป็น ws://.../wss://... อยู่แล้วถ้าไม่ขึ้นด้วย http(s)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

/**
 * poll หา terminal session ที่ pending แล้ว claim+เปิด terminal ให้ — หลาย session พร้อมกันได้
 * (ดู comment บนสุดของไฟล์ว่าทำไมไม่ serialize เหมือน backup) claim แล้วปล่อยให้ handleSession
 * ทำงานเป็น background task, loop กลับไป claim รอบถัดไปทันทีไม่รอ sleep เผื่อมี pending ค้างอีก
 *
 * signal abort (worker shutdown): หยุด poll ใหม่ทันที แล้วรอทุก session ที่ active อยู่ปิดตัวเอง
 * ให้เสร็จก่อน (handleSession ฟัง signal เดียวกันแล้ว finish("shutdown") เอง)
 */
export async function terminalSessionLoop(
  db: Database,
  docker: DockerCliClient,
  controlApiUrl: string,
  signal: AbortSignal,
  options: TerminalLoopOptions = {},
): Promise<void> {
  const opts: ResolvedOptions = {
    onLog: options.onLog ?? (() => {}),
    connect: options.connect ?? defaultConnect,
    idleTimeoutMs: options.idleTimeoutMs ?? TERMINAL_SETTINGS.idleTimeoutMs,
    idleCheckIntervalMs: options.idleCheckIntervalMs ?? 5_000,
    connectTimeoutMs: options.connectTimeoutMs ?? TERMINAL_SETTINGS.browserWaitTimeoutMs,
    initialSizeWaitMs: options.initialSizeWaitMs ?? 750,
  };

  const active = new Set<Promise<void>>();

  while (!signal.aborted) {
    let row: TerminalSessionRow | null = null;
    try {
      row = claimNextPendingSession(db);
    } catch (err) {
      opts.onLog(
        `terminal session loop claim error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (row) {
      const claimedRow = row;
      const task = handleSession(db, docker, controlApiUrl, claimedRow, signal, opts).catch(
        (err) => {
          opts.onLog(
            `terminal session ${claimedRow.id} error ที่ไม่คาดคิด: ${err instanceof Error ? err.message : String(err)}`,
          );
          try {
            markFailed(db, claimedRow.id, err instanceof Error ? err.message : String(err));
          } catch {
            // ไม่สำคัญถ้าอัปเดตไม่สำเร็จ — worker จะ recover session ค้างในรอบถัดไปไม่ได้ (ไม่มี lease
            // mechanism สำหรับตารางนี้) แต่ error ที่ทำให้มาถึงจุดนี้ควรเกิดยากมาก
          }
        },
      );
      active.add(task);
      void task.finally(() => active.delete(task));
      continue; // ลอง claim รอบถัดไปทันที เผื่อมี pending row อื่นค้างอยู่ ไม่ต้องรอ poll interval
    }

    await sleep(TERMINAL_SETTINGS.pollIntervalMs, signal);
  }

  await Promise.allSettled(active);
}
