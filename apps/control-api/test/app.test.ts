import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { WORKER_HEARTBEAT } from "@zixploy/shared";
import { buildApp } from "../src/app";

function makeApp() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return { db, app: buildApp(db) };
}

// biome-ignore lint/suspicious/noExplicitAny: test helper อ่าน response body แบบไม่ผูก schema
async function json(res: Response): Promise<any> {
  return res.json();
}

describe("GET /api/v1/system/health", () => {
  test("db ready แต่ worker ไม่มี heartbeat = degraded", async () => {
    const { app } = makeApp();
    const res = await app.handle(new Request("http://localhost/api/v1/system/health"));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe("degraded");
    expect(body.checks.database.ready).toBe(true);
    expect(body.checks.worker.ready).toBe(false);
  });

  test("worker heartbeat สด = ok", async () => {
    const { db, app } = makeApp();
    db.query(
      "INSERT INTO worker_heartbeats (worker_id, started_at, last_beat_at) VALUES (?, ?, ?)",
    ).run("w1", Date.now(), Date.now());
    const body = await json(await app.handle(new Request("http://localhost/api/v1/system/health")));
    expect(body.status).toBe("ok");
    expect(body.checks.worker.ready).toBe(true);
  });

  test("heartbeat ค้างเกิน threshold = worker not ready", async () => {
    const { db, app } = makeApp();
    db.query(
      "INSERT INTO worker_heartbeats (worker_id, started_at, last_beat_at) VALUES (?, ?, ?)",
    ).run("w1", Date.now(), Date.now() - WORKER_HEARTBEAT.staleMs - 1000);
    const body = await json(await app.handle(new Request("http://localhost/api/v1/system/health")));
    expect(body.status).toBe("degraded");
    expect(body.checks.worker.detail).toContain("stale");
  });
});

describe("request ID", () => {
  test("generate ให้เมื่อ client ไม่ส่งมา", async () => {
    const { app } = makeApp();
    const res = await app.handle(new Request("http://localhost/api/v1/system/health"));
    expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test("ใช้ค่า client เมื่อ format ถูกต้อง / ทิ้งเมื่อ format ผิด", async () => {
    const { app } = makeApp();
    const ok = await app.handle(
      new Request("http://localhost/api/v1/system/health", {
        headers: { "X-Request-Id": "client-id-123" },
      }),
    );
    expect(ok.headers.get("X-Request-Id")).toBe("client-id-123");

    const bad = await app.handle(
      new Request("http://localhost/api/v1/system/health", {
        headers: { "X-Request-Id": "bad id with spaces!!" },
      }),
    );
    expect(bad.headers.get("X-Request-Id")).not.toBe("bad id with spaces!!");
  });
});

describe("error envelope", () => {
  test("unknown route ตอบ NOT_FOUND envelope พร้อม requestId", async () => {
    const { app } = makeApp();
    const res = await app.handle(new Request("http://localhost/api/v1/nope"));
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(typeof body.error.message).toBe("string");
    expect(typeof body.error.requestId).toBe("string");
  });
});
