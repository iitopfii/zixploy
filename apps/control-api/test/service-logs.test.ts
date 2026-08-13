/**
 * Service (database) log routes — Phase 15
 *
 * Copy โครงจาก runtime-logs-tail.test.ts (project runtime logs) เพราะ implementation แชร์
 * ตรรกะเดียวกันเป๊ะ (ringLogSseStream) — ครอบเคสเดียวกันเพื่อจับ regression ถ้าใครแยกโค้ดกลับ
 * ไปคนละที่แล้วบั๊กเดิม (log เก่าสุดแทนล่าสุด, SSE ไม่อ่าน ?afterSeq) หลุดกลับมาเฉพาะฝั่ง service
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { listServiceLogs, tailServiceLogs } from "../src/logs/service-store";
import { json } from "./helpers";

async function setup(logCount = 0) {
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

  const insert = db.query(
    `INSERT INTO service_logs (id, service_id, container_id, seq, stream, line, logged_at, created_at)
     VALUES (?, ?, 'c1', ?, 'stdout', ?, ?, ?)`,
  );
  db.transaction(() => {
    for (let i = 1; i <= logCount; i++) {
      insert.run(ulid(), serviceId, i, `line-${i}`, now + i, now + i);
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

  return { db, app, cookie, serviceId };
}

// ---------------------------------------------------------------------------

describe("tailServiceLogs", () => {
  test("คืนบรรทัดล่าสุด ไม่ใช่เก่าสุด", async () => {
    const { db, serviceId } = await setup(1000);
    const tail = tailServiceLogs(db, serviceId, 10);

    expect(tail).toHaveLength(10);
    expect(tail[0]?.line).toBe("line-991");
    expect(tail[9]?.line).toBe("line-1000");
  });

  test("เรียงเก่า→ใหม่ (ต่อท้าย stream ได้ตรง ๆ)", async () => {
    const { db, serviceId } = await setup(50);
    const seqs = tailServiceLogs(db, serviceId, 5).map((l) => l.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  test("log น้อยกว่า limit → คืนเท่าที่มี", async () => {
    const { db, serviceId } = await setup(3);
    expect(tailServiceLogs(db, serviceId, 100)).toHaveLength(3);
  });

  test("ไม่มี log เลย → []", async () => {
    const { db, serviceId } = await setup(0);
    expect(tailServiceLogs(db, serviceId)).toEqual([]);
  });

  test("limit ถูก cap ที่ 500", async () => {
    const { db, serviceId } = await setup(1200);
    expect(tailServiceLogs(db, serviceId, 99999)).toHaveLength(500);
  });

  test("ต่างจาก listServiceLogs ที่เดินหน้าจาก cursor 0", async () => {
    const { db, serviceId } = await setup(1000);
    expect(listServiceLogs(db, serviceId, { afterSeq: 0 })[0]?.line).toBe("line-1");
    expect(tailServiceLogs(db, serviceId)[0]?.line).not.toBe("line-1");
  });
});

describe("GET /services/:id/logs", () => {
  test("ไม่ส่ง cursor → ได้บรรทัดล่าสุด", async () => {
    const { app, cookie, serviceId } = await setup(600);
    const body = await json(
      await app.handle(
        new Request(`http://localhost/api/v1/services/${serviceId}/logs`, {
          headers: { cookie },
        }),
      ),
    );
    const lines = body.logs.map((l: { line: string }) => l.line);
    expect(lines[lines.length - 1]).toBe("line-600");
    expect(lines).not.toContain("line-1");
  });

  test("ส่ง cursor → เดินหน้าจากจุดนั้น", async () => {
    const { app, cookie, serviceId } = await setup(100);
    const body = await json(
      await app.handle(
        new Request(`http://localhost/api/v1/services/${serviceId}/logs?afterSeq=90`, {
          headers: { cookie },
        }),
      ),
    );
    expect(body.logs).toHaveLength(10);
    expect(body.logs[0].line).toBe("line-91");
  });

  test("service ไม่มีอยู่จริง → 404 SERVICE_NOT_FOUND", async () => {
    const { app, cookie } = await setup(0);
    const res = await app.handle(
      new Request(`http://localhost/api/v1/services/${ulid()}/logs`, { headers: { cookie } }),
    );
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("SERVICE_NOT_FOUND");
  });

  test("ไม่ login → 401", async () => {
    const { app, serviceId } = await setup(1);
    const res = await app.handle(new Request(`http://localhost/api/v1/services/${serviceId}/logs`));
    expect(res.status).toBe(401);
  });
});

describe("SSE — GET /services/:id/logs/stream", () => {
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
    const { app, cookie, serviceId } = await setup(300);
    const res = await app.handle(
      new Request(`http://localhost/api/v1/services/${serviceId}/logs/stream?afterSeq=300`, {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(200);

    const text = await readFirstChunk(res);
    expect(text).not.toContain('line-1"');
    expect(text).not.toContain("line-300");
  });

  test("ไม่ส่ง cursor → ยังยิงประวัติมาให้", async () => {
    const { app, cookie, serviceId } = await setup(5);
    const res = await app.handle(
      new Request(`http://localhost/api/v1/services/${serviceId}/logs/stream`, {
        headers: { cookie },
      }),
    );
    const text = await readFirstChunk(res);
    expect(text).toContain("line-1");
  });

  test("Last-Event-ID มาก่อน ?afterSeq เมื่อมีทั้งคู่", async () => {
    const { app, cookie, serviceId } = await setup(10);
    const res = await app.handle(
      new Request(`http://localhost/api/v1/services/${serviceId}/logs/stream?afterSeq=0`, {
        headers: { cookie, "last-event-id": "10" },
      }),
    );
    const text = await readFirstChunk(res);
    expect(text).not.toContain("line-1");
  });
});
