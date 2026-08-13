/**
 * terminalSessionLoop — unit tests (Phase 17)
 *
 * mock ทั้งสองด้านที่ยากทดสอบจริง: WebSocket client (fake WebSocketLike ควบคุมด้วยมือ —
 * .triggerOpen()/.triggerMessage()/.triggerClose()/.triggerError()) และ docker exec subprocess
 * (fake ExecProcess: stdin จำ write ทุกครั้ง, stdout/stderr เป็น ReadableStream ควบคุมได้,
 * exited เป็น Promise ที่ resolve เองได้ — เหมือนแนวทาง mockDocker ใน services-backup.test.ts)
 *
 * claimNextPendingSession export จากไฟล์จริงมาเทสต์ atomic claim ตรง ๆ ไม่ต้องพึ่ง timing ของ
 * loop เต็ม (แนวทางเดียวกับ claimNextJob ใน queue.test.ts)
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { resetInternalTokenCache } from "../src/internal-token";
import {
  type ConnectFn,
  claimNextPendingSession,
  terminalSessionLoop,
  type WebSocketLike,
} from "../src/services/terminal-session-loop";

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function insertService(db: ReturnType<typeof makeDb>): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO services
      (id, name, type, version, image, status, container_id, volume_name,
       username, database_name, internal_port, created_at, updated_at)
     VALUES (?, ?, 'postgres', '16', 'postgres:16', 'running', 'c1', ?, 'app', 'app', 5432, ?, ?)`,
  ).run(id, `db-${id.toLowerCase()}`, `zxsvcvol-${id.toLowerCase()}`, now, now);
  return id;
}

function insertPendingSession(db: ReturnType<typeof makeDb>, serviceId: string): string {
  const id = ulid();
  db.query(
    "INSERT INTO terminal_sessions (id, service_id, status, created_at) VALUES (?, ?, 'pending', ?)",
  ).run(id, serviceId, Date.now());
  return id;
}

function getSession(db: ReturnType<typeof makeDb>, id: string) {
  return db
    .query<
      {
        status: string;
        failure_message: string | null;
        claimed_at: number | null;
        closed_at: number | null;
      },
      [string]
    >("SELECT status, failure_message, claimed_at, closed_at FROM terminal_sessions WHERE id = ?")
    .get(id)!;
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  sent: (string | ArrayBufferLike | ArrayBufferView)[] = [];
  closed = false;
  closeCode: number | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer | Uint8Array }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(
    public url: string,
    public headers: Record<string, string>,
  ) {}

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.closeCode = code;
    this.onclose?.({ code, reason });
  }

  triggerOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  triggerMessage(data: string | ArrayBuffer | Uint8Array): void {
    this.onmessage?.({ data });
  }

  triggerError(err: unknown): void {
    this.onerror?.(err);
  }

  triggerClose(code = 1000, reason = "browser disconnected"): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function makeConnectFn(): { connect: ConnectFn; sockets: FakeWebSocket[] } {
  const sockets: FakeWebSocket[] = [];
  const connect: ConnectFn = (url, headers) => {
    const ws = new FakeWebSocket(url, headers);
    sockets.push(ws);
    return ws;
  };
  return { connect, sockets };
}

function makeFakeStream(): {
  stream: ReadableStream<Uint8Array>;
  push: (chunk: Uint8Array) => void;
  close: () => void;
} {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller;
    },
  });
  return {
    stream,
    push: (chunk) => ctrl.enqueue(chunk),
    close: () => {
      try {
        ctrl.close();
      } catch {
        // อาจปิดไปแล้ว
      }
    },
  };
}

function makeFakeProc() {
  const stdinWrites: Uint8Array[] = [];
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>((res) => {
    resolveExited = res;
  });
  let killed = false;
  const out = makeFakeStream();
  const err = makeFakeStream();

  const proc = {
    stdin: {
      write: (data: string | ArrayBufferView | ArrayBuffer) => {
        const bytes =
          typeof data === "string"
            ? new TextEncoder().encode(data)
            : data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        stdinWrites.push(bytes);
        return bytes.byteLength;
      },
      flush: () => 0,
    },
    stdout: out.stream,
    stderr: err.stream,
    get killed() {
      return killed;
    },
    kill: () => {
      killed = true;
    },
    exited,
  };

  return {
    proc,
    stdinWrites,
    pushStdout: out.push,
    closeStdout: out.close,
    pushStderr: err.push,
    closeStderr: err.close,
    exitWith: (code: number) => resolveExited(code),
    isKilled: () => killed,
  };
}

function makeDockerMock() {
  const fakeProcs: ReturnType<typeof makeFakeProc>[] = [];
  const reapCalls: Array<{ containerName: string; marker: string }> = [];
  const execInteractive = (
    _containerName: string,
    _shell: string,
    _opts?: { cols?: number; rows?: number; sessionMarker?: string },
  ) => {
    const fp = makeFakeProc();
    fakeProcs.push(fp);
    return fp.proc;
  };
  const reapTerminalShell = async (containerName: string, marker: string) => {
    reapCalls.push({ containerName, marker });
  };
  return { execInteractive, reapTerminalShell, fakeProcs, reapCalls };
}

/** รอ microtask/timer สั้น ๆ ให้ async code ในโปรดักชันได้ทำงานต่อ */
function tick(ms = 15): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

const CONTROL_API_URL = "http://control-api:3001";

afterEach(() => {
  resetInternalTokenCache();
  delete process.env.ZIXPLOY_INTERNAL_TOKEN_FILE;
});

function setFakeToken(): void {
  // loadInternalToken() อ่านจากไฟล์แบบ sync — เขียนไฟล์ temp จริงแล้วชี้ env ไปที่นั่น
  const path = join(tmpdir(), `zx-terminal-test-token-${ulid()}.txt`);
  writeFileSync(path, "test-internal-token");
  process.env.ZIXPLOY_INTERNAL_TOKEN_FILE = path;
  resetInternalTokenCache();
}

// ---------------------------------------------------------------------------

describe("claimNextPendingSession — atomic claim", () => {
  test("claim แถว pending สำเร็จ → status เปลี่ยนเป็น active, claimed_at ถูกตั้ง", () => {
    const db = makeDb();
    const serviceId = insertService(db);
    const sessionId = insertPendingSession(db, serviceId);

    const claimed = claimNextPendingSession(db);
    expect(claimed?.id).toBe(sessionId);

    const row = getSession(db, sessionId);
    expect(row.status).toBe("active");
    expect(row.claimed_at).not.toBeNull();
  });

  test("claim ซ้ำครั้งที่สอง → คืน null ไม่ claim ซ้ำ (row เดียวกันไม่ถูกจับสองรอบ)", () => {
    const db = makeDb();
    const serviceId = insertService(db);
    insertPendingSession(db, serviceId);

    const first = claimNextPendingSession(db);
    const second = claimNextPendingSession(db);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test("ไม่มี pending row → คืน null", () => {
    const db = makeDb();
    expect(claimNextPendingSession(db)).toBeNull();
  });
});

describe("terminalSessionLoop — internal token ไม่ได้ตั้งค่า", () => {
  test("ไม่มี ZIXPLOY_INTERNAL_TOKEN_FILE → mark failed ทันทีโดยไม่ connect", async () => {
    const db = makeDb();
    const serviceId = insertService(db);
    const sessionId = insertPendingSession(db, serviceId);
    const docker = makeDockerMock();
    const { connect, sockets } = makeConnectFn();

    const controller = new AbortController();
    const loopPromise = terminalSessionLoop(
      db,
      docker as never,
      CONTROL_API_URL,
      controller.signal,
      { connect },
    );
    await tick();
    controller.abort();
    await loopPromise;

    expect(sockets).toHaveLength(0);
    const row = getSession(db, sessionId);
    expect(row.status).toBe("failed");
    expect(row.failure_message).toContain("internal token");
  });
});

describe("terminalSessionLoop — connect ล้มเหลว", () => {
  test("timeout ก่อน open → mark failed พร้อม reason", async () => {
    setFakeToken();
    const db = makeDb();
    const serviceId = insertService(db);
    const sessionId = insertPendingSession(db, serviceId);
    const docker = makeDockerMock();
    const { connect } = makeConnectFn(); // ไม่มีใคร trigger open เลย — ปล่อยให้ timeout

    const controller = new AbortController();
    const loopPromise = terminalSessionLoop(
      db,
      docker as never,
      CONTROL_API_URL,
      controller.signal,
      { connect, connectTimeoutMs: 30 },
    );
    await tick(80);
    controller.abort();
    await loopPromise;

    const row = getSession(db, sessionId);
    expect(row.status).toBe("failed");
    expect(row.failure_message).toBeTruthy();
    expect(row.closed_at).not.toBeNull();
    expect(docker.fakeProcs).toHaveLength(0); // ไม่เคย spawn docker exec เลยเพราะ connect ไม่สำเร็จ
  });

  test("server ปฏิเสธด้วย error event → mark failed พร้อมข้อความจาก error", async () => {
    setFakeToken();
    const db = makeDb();
    const serviceId = insertService(db);
    const sessionId = insertPendingSession(db, serviceId);
    const docker = makeDockerMock();
    const { connect, sockets } = makeConnectFn();

    const controller = new AbortController();
    const loopPromise = terminalSessionLoop(
      db,
      docker as never,
      CONTROL_API_URL,
      controller.signal,
      { connect, connectTimeoutMs: 5_000 },
    );
    await tick();
    expect(sockets).toHaveLength(1);
    sockets[0]!.triggerError({ message: "unauthorized: bad internal token" });

    await tick();
    controller.abort();
    await loopPromise;

    const row = getSession(db, sessionId);
    expect(row.status).toBe("failed");
    expect(row.failure_message).toContain("unauthorized");
  });
});

describe("terminalSessionLoop — happy path round trip", () => {
  test("browser→worker เขียนลง stdin, process stdout ส่งกลับเป็น binary frame", async () => {
    setFakeToken();
    const db = makeDb();
    const serviceId = insertService(db);
    const sessionId = insertPendingSession(db, serviceId);
    const docker = makeDockerMock();
    const { connect, sockets } = makeConnectFn();

    const controller = new AbortController();
    const loopPromise = terminalSessionLoop(
      db,
      docker as never,
      CONTROL_API_URL,
      controller.signal,
      { connect, idleTimeoutMs: 10_000, idleCheckIntervalMs: 5_000, initialSizeWaitMs: 0 },
    );

    await tick();
    expect(sockets).toHaveLength(1);
    const ws = sockets[0]!;
    expect(ws.url).toBe(`ws://control-api:3001/internal/terminal-relay/${sessionId}`);
    expect(ws.headers.Authorization).toBe("Bearer test-internal-token");

    ws.triggerOpen();
    await tick();

    expect(docker.fakeProcs).toHaveLength(1);
    const fp = docker.fakeProcs[0]!;

    // browser พิมพ์คำสั่ง → binary frame → เขียนลง stdin ของ docker exec
    const keystrokes = new TextEncoder().encode("ls\n");
    ws.triggerMessage(keystrokes);
    await tick();
    expect(fp.stdinWrites).toHaveLength(1);
    expect(new TextDecoder().decode(fp.stdinWrites[0])).toBe("ls\n");

    // resize control message (text frame) → no-op, ไม่ throw ไม่เขียน stdin เพิ่ม
    ws.triggerMessage(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    await tick();
    expect(fp.stdinWrites).toHaveLength(1);

    // process stdout → forward เป็น binary frame กลับไปที่ WebSocket
    const output = new TextEncoder().encode("file1.txt\nfile2.txt\n");
    fp.pushStdout(output);
    await tick();
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toBe(output);

    // stderr ก็ถูก merge เข้า stream เดียวกัน
    const errOutput = new TextEncoder().encode("warning: something\n");
    fp.pushStderr(errOutput);
    await tick();
    expect(ws.sent).toHaveLength(2);

    const row = getSession(db, sessionId);
    expect(row.status).toBe("active");

    controller.abort();
    await loopPromise;
  });
});

describe("terminalSessionLoop — ปิด session", () => {
  test("browser ปิด WebSocket → kill process, mark closed", async () => {
    setFakeToken();
    const db = makeDb();
    const serviceId = insertService(db);
    const sessionId = insertPendingSession(db, serviceId);
    const docker = makeDockerMock();
    const { connect, sockets } = makeConnectFn();

    const controller = new AbortController();
    const loopPromise = terminalSessionLoop(
      db,
      docker as never,
      CONTROL_API_URL,
      controller.signal,
      { connect, idleTimeoutMs: 10_000, idleCheckIntervalMs: 5_000, initialSizeWaitMs: 0 },
    );
    await tick();
    sockets[0]!.triggerOpen();
    await tick();

    const fp = docker.fakeProcs[0]!;
    expect(fp.isKilled()).toBe(false);

    sockets[0]!.triggerClose(1000, "browser disconnected");
    await tick();

    expect(fp.isKilled()).toBe(true);
    // ต้อง reap shell ในคอนเทนเนอร์ด้วย marker = session id — docker exec -it ทิ้ง shell ค้างไว้
    // เมื่อ client ตาย การ kill `script` ฝั่ง worker ไม่พอ (regression ที่ review จับได้)
    expect(docker.reapCalls).toContainEqual({
      containerName: `zxsvc-${serviceId.toLowerCase()}`,
      marker: sessionId,
    });
    const row = getSession(db, sessionId);
    expect(row.status).toBe("closed");
    expect(row.closed_at).not.toBeNull();

    controller.abort();
    await loopPromise;
  });

  test("ผู้ใช้พิมพ์ exit (process จบเอง) → ปิด WebSocket, mark closed", async () => {
    setFakeToken();
    const db = makeDb();
    const serviceId = insertService(db);
    const sessionId = insertPendingSession(db, serviceId);
    const docker = makeDockerMock();
    const { connect, sockets } = makeConnectFn();

    const controller = new AbortController();
    const loopPromise = terminalSessionLoop(
      db,
      docker as never,
      CONTROL_API_URL,
      controller.signal,
      { connect, idleTimeoutMs: 10_000, idleCheckIntervalMs: 5_000, initialSizeWaitMs: 0 },
    );
    await tick();
    sockets[0]!.triggerOpen();
    await tick();

    const ws = sockets[0]!;
    expect(ws.closed).toBe(false);

    const fp = docker.fakeProcs[0]!;
    fp.exitWith(0);
    await tick();

    expect(ws.closed).toBe(true);
    const row = getSession(db, sessionId);
    expect(row.status).toBe("closed");

    controller.abort();
    await loopPromise;
  });

  test("idle timeout → kill process, ปิด WebSocket, mark closed", async () => {
    setFakeToken();
    const db = makeDb();
    const serviceId = insertService(db);
    const sessionId = insertPendingSession(db, serviceId);
    const docker = makeDockerMock();
    const { connect, sockets } = makeConnectFn();

    const controller = new AbortController();
    const loopPromise = terminalSessionLoop(
      db,
      docker as never,
      CONTROL_API_URL,
      controller.signal,
      { connect, idleTimeoutMs: 40, idleCheckIntervalMs: 10, initialSizeWaitMs: 0 },
    );
    await tick();
    sockets[0]!.triggerOpen();
    await tick();

    const fp = docker.fakeProcs[0]!;
    // ไม่มี activity ใด ๆ เพิ่มเติมหลัง open — รอเกิน idleTimeoutMs
    await tick(120);

    expect(fp.isKilled()).toBe(true);
    expect(sockets[0]!.closed).toBe(true);
    const row = getSession(db, sessionId);
    expect(row.status).toBe("closed");

    controller.abort();
    await loopPromise;
  });
});

describe("terminalSessionLoop — worker shutdown", () => {
  test("abort signal ระหว่าง session active → kill process, ปิด ws, mark closed แล้ว loop จบ", async () => {
    setFakeToken();
    const db = makeDb();
    const serviceId = insertService(db);
    const sessionId = insertPendingSession(db, serviceId);
    const docker = makeDockerMock();
    const { connect, sockets } = makeConnectFn();

    const controller = new AbortController();
    const loopPromise = terminalSessionLoop(
      db,
      docker as never,
      CONTROL_API_URL,
      controller.signal,
      { connect, idleTimeoutMs: 10_000, idleCheckIntervalMs: 5_000, initialSizeWaitMs: 0 },
    );
    await tick();
    sockets[0]!.triggerOpen();
    await tick();

    const fp = docker.fakeProcs[0]!;
    controller.abort();
    await loopPromise;

    expect(fp.isKilled()).toBe(true);
    const row = getSession(db, sessionId);
    expect(row.status).toBe("closed");
  });
});
