/**
 * Runtime log tail + SSE cursor — regression tests
 *
 * ครอบบั๊กที่ทำให้หน้า Logs ค้างจนเบราว์เซอร์แฮงก์:
 * 1. เปิดหน้าครั้งแรกได้ log "เก่าสุด" ของ ring buffer แทนที่จะเป็นล่าสุด
 * 2. SSE ไม่อ่าน ?afterSeq (อ่านแต่ header Last-Event-ID) → เชื่อมครั้งแรก afterSeq=0
 *    แล้วยิง ring buffer ทั้งก้อนกลับไปซ้ำกับที่ client โหลดไปแล้ว
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { listRuntimeLogs, tailRuntimeLogs } from "../src/logs/runtime-store";
import { json } from "./helpers";

async function setup(logCount = 0) {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));

  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)",
  ).run(ulid(), await hashPassword("adminpass123"), now, now);

  const projectId = ulid();
  db.query(
    `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'proj', 'running', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(projectId, now, now);

  const insert = db.query(
    `INSERT INTO runtime_logs (id, project_id, container_id, seq, stream, line, logged_at, created_at)
     VALUES (?, ?, 'c1', ?, 'stdout', ?, ?, ?)`,
  );
  db.transaction(() => {
    for (let i = 1; i <= logCount; i++) {
      insert.run(ulid(), projectId, i, `line-${i}`, now + i, now + i);
    }
  })();

  const app = buildApp(db);
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

  return { db, app, cookie, projectId };
}

// ---------------------------------------------------------------------------

describe("tailRuntimeLogs", () => {
  test("คืนบรรทัดล่าสุด ไม่ใช่เก่าสุด", async () => {
    const { db, projectId } = await setup(1000);
    const tail = tailRuntimeLogs(db, projectId, 10);

    expect(tail).toHaveLength(10);
    expect(tail[0]?.line).toBe("line-991");
    expect(tail[9]?.line).toBe("line-1000");
  });

  test("เรียงเก่า→ใหม่ (ต่อท้าย stream ได้ตรง ๆ)", async () => {
    const { db, projectId } = await setup(50);
    const seqs = tailRuntimeLogs(db, projectId, 5).map((l) => l.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  test("log น้อยกว่า limit → คืนเท่าที่มี", async () => {
    const { db, projectId } = await setup(3);
    expect(tailRuntimeLogs(db, projectId, 100)).toHaveLength(3);
  });

  test("ไม่มี log เลย → []", async () => {
    const { db, projectId } = await setup(0);
    expect(tailRuntimeLogs(db, projectId)).toEqual([]);
  });

  test("limit ถูก cap ที่ 500 — กันดึงทั้ง ring buffer มา render", async () => {
    const { db, projectId } = await setup(1200);
    expect(tailRuntimeLogs(db, projectId, 99999)).toHaveLength(500);
  });

  test("ต่างจาก listRuntimeLogs ที่เดินหน้าจาก cursor 0 (พฤติกรรมเดิมที่เป็นบั๊ก)", async () => {
    const { db, projectId } = await setup(1000);
    // เดิม: เปิดหน้าแล้วได้ line-1 (เก่าสุด) — ตรงข้ามกับที่ผู้ใช้ต้องการ
    expect(listRuntimeLogs(db, projectId, { afterSeq: 0 })[0]?.line).toBe("line-1");
    expect(tailRuntimeLogs(db, projectId)[0]?.line).not.toBe("line-1");
  });
});

describe("GET /projects/:id/runtime-logs", () => {
  test("ไม่ส่ง cursor → ได้บรรทัดล่าสุด", async () => {
    const { app, cookie, projectId } = await setup(600);
    const body = await json(
      await app.handle(
        new Request(`http://localhost/api/v1/projects/${projectId}/runtime-logs`, {
          headers: { cookie },
        }),
      ),
    );
    const lines = body.logs.map((l: { line: string }) => l.line);
    expect(lines[lines.length - 1]).toBe("line-600");
    expect(lines).not.toContain("line-1");
  });

  test("ส่ง cursor → เดินหน้าจากจุดนั้น (pagination เดิมยังทำงาน)", async () => {
    const { app, cookie, projectId } = await setup(100);
    const body = await json(
      await app.handle(
        new Request(`http://localhost/api/v1/projects/${projectId}/runtime-logs?afterSeq=90`, {
          headers: { cookie },
        }),
      ),
    );
    expect(body.logs).toHaveLength(10);
    expect(body.logs[0].line).toBe("line-91");
  });
});

describe("SSE cursor — ?afterSeq ต้องถูกอ่าน", () => {
  /** อ่าน SSE ที่ส่งมาช่วงสั้น ๆ แล้วปิด — พอสำหรับดูว่า batch แรกมีอะไร */
  async function readFirstChunk(res: Response, ms = 400): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) return "";
    let text = "";
    const deadline = Date.now() + ms;
    try {
      while (Date.now() < deadline) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r) =>
            setTimeout(() => r({ done: true, value: undefined }), ms),
          ),
        ]);
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return text;
  }

  test("ส่ง ?afterSeq → ไม่ยิง log เก่ากลับมาซ้ำ", async () => {
    const { app, cookie, projectId } = await setup(300);
    const res = await app.handle(
      new Request(
        `http://localhost/api/v1/projects/${projectId}/runtime-logs/stream?afterSeq=300`,
        { headers: { cookie } },
      ),
    );
    expect(res.status).toBe(200);

    const text = await readFirstChunk(res);
    // client มีถึง seq 300 แล้ว — ต้องไม่ได้ line-1..300 กลับมา
    expect(text).not.toContain('line-1"');
    expect(text).not.toContain("line-300");
  });

  test("ไม่ส่ง cursor → ยังยิงประวัติมาให้ (พฤติกรรมเดิมสำหรับ client ที่เพิ่งเปิด)", async () => {
    const { app, cookie, projectId } = await setup(5);
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/runtime-logs/stream`, {
        headers: { cookie },
      }),
    );
    const text = await readFirstChunk(res);
    expect(text).toContain("line-1");
  });

  test("Last-Event-ID มาก่อน ?afterSeq เมื่อมีทั้งคู่ (มาตรฐาน SSE reconnect)", async () => {
    const { app, cookie, projectId } = await setup(10);
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/runtime-logs/stream?afterSeq=0`, {
        headers: { cookie, "last-event-id": "10" },
      }),
    );
    const text = await readFirstChunk(res);
    // header บอกว่าได้ถึง seq 10 แล้ว → ไม่ควรได้อะไรย้อนหลัง
    expect(text).not.toContain("line-1");
  });

  test("afterSeq ที่ไม่ใช่ตัวเลข → ถือว่าไม่มี cursor (ไม่ crash)", async () => {
    const { app, cookie, projectId } = await setup(3);
    const res = await app.handle(
      new Request(
        `http://localhost/api/v1/projects/${projectId}/runtime-logs/stream?afterSeq=DROP+TABLE`,
        { headers: { cookie } },
      ),
    );
    expect(res.status).toBe(200);
    await readFirstChunk(res, 200);
  });
});
