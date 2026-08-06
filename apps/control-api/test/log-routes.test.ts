/**
 * Log Routes API — HTTP round-trip tests (docs/phase-06-logs.md M3 + M4)
 *
 * ครอบคลุม:
 * - GET /deployments/:id/logs → paginated build logs (afterSeq, limit)
 * - GET /deployments/:id/logs/download → plain text
 * - GET /projects/:id/runtime-logs → paginated runtime logs
 * - Unauthenticated → 401
 * - Deployment/Project ไม่มีอยู่ → 404
 * - afterSeq cursor pagination ทำงานถูกต้อง
 * - SSE endpoint เริ่ม stream ได้ (ไม่ test long-running — integration test ใช้ unit mock)
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { json } from "./helpers";

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

async function setup() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));

  const now = Date.now();
  const userId = ulid();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)",
  ).run(userId, await hashPassword("adminpass123"), now, now);

  const projectId = ulid();
  db.query(
    `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'log-test', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(projectId, now, now);

  const deploymentId = ulid();
  db.query(
    `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
     VALUES (?, ?, 'succeeded', 'push', 'abc123', ?, ?, ?)`,
  ).run(deploymentId, projectId, now, now, now);

  const app = buildApp(db);

  // login
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

  function cookieHeader() {
    return Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  function auth(req: Request): Request {
    req.headers.set("cookie", cookieHeader());
    req.headers.set("x-csrf-token", cookies["csrf"] ?? "");
    return req;
  }

  // insert build logs directly into DB
  function insertBuildLog(seq: number, line: string, stream: "stdout" | "stderr" = "stdout") {
    db.query(
      `INSERT INTO build_logs (id, deployment_id, seq, stream, line, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(ulid(), deploymentId, seq, stream, line, now + seq * 10);
  }

  // insert runtime logs directly into DB
  function insertRuntimeLog(seq: number, line: string, containerId = "c123") {
    db.query(
      `INSERT INTO runtime_logs (id, project_id, container_id, seq, stream, line, logged_at, created_at)
       VALUES (?, ?, ?, ?, 'stdout', ?, ?, ?)`,
    ).run(ulid(), projectId, containerId, seq, line, now, now);
  }

  return { db, app, auth, deploymentId, projectId, insertBuildLog, insertRuntimeLog };
}

// ---------------------------------------------------------------------------
// Build log — GET /deployments/:id/logs
// ---------------------------------------------------------------------------

describe("GET /deployments/:id/logs", () => {
  test("คืน empty array เมื่อไม่มี log", async () => {
    const { app, auth, deploymentId } = await setup();
    const res = await app.handle(
      auth(new Request(`http://localhost/api/v1/deployments/${deploymentId}/logs`)),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.logs).toEqual([]);
  });

  test("คืน log rows ตาม seq ASC", async () => {
    const { app, auth, deploymentId, insertBuildLog } = await setup();
    insertBuildLog(1, "step one");
    insertBuildLog(2, "step two");
    insertBuildLog(3, "step three");

    const res = await app.handle(
      auth(new Request(`http://localhost/api/v1/deployments/${deploymentId}/logs`)),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.logs).toHaveLength(3);
    expect(body.logs[0].seq).toBe(1);
    expect(body.logs[0].line).toBe("step one");
    expect(body.logs[2].seq).toBe(3);
  });

  test("afterSeq cursor — คืนเฉพาะ row ที่ seq > afterSeq", async () => {
    const { app, auth, deploymentId, insertBuildLog } = await setup();
    for (let i = 1; i <= 5; i++) insertBuildLog(i, `line ${i}`);

    const res = await app.handle(
      auth(new Request(`http://localhost/api/v1/deployments/${deploymentId}/logs?afterSeq=3`)),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.logs).toHaveLength(2);
    expect(body.logs[0].seq).toBe(4);
    expect(body.logs[1].seq).toBe(5);
  });

  test("limit query param จำกัดจำนวน rows", async () => {
    const { app, auth, deploymentId, insertBuildLog } = await setup();
    for (let i = 1; i <= 10; i++) insertBuildLog(i, `line ${i}`);

    const res = await app.handle(
      auth(new Request(`http://localhost/api/v1/deployments/${deploymentId}/logs?limit=3`)),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.logs).toHaveLength(3);
  });

  test("stream field ครบ stdout/stderr", async () => {
    const { app, auth, deploymentId, insertBuildLog } = await setup();
    insertBuildLog(1, "out", "stdout");
    insertBuildLog(2, "err", "stderr");

    const body = await json(
      await app.handle(
        auth(new Request(`http://localhost/api/v1/deployments/${deploymentId}/logs`)),
      ),
    );
    expect(body.logs[0].stream).toBe("stdout");
    expect(body.logs[1].stream).toBe("stderr");
  });

  test("deployment ไม่มีอยู่ → 404", async () => {
    const { app, auth } = await setup();
    const res = await app.handle(
      auth(new Request(`http://localhost/api/v1/deployments/${ulid()}/logs`)),
    );
    expect(res.status).toBe(404);
  });

  test("unauthenticated → 401", async () => {
    const { app, deploymentId } = await setup();
    const res = await app.handle(
      new Request(`http://localhost/api/v1/deployments/${deploymentId}/logs`),
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Build log download — GET /deployments/:id/logs/download
// ---------------------------------------------------------------------------

describe("GET /deployments/:id/logs/download", () => {
  test("คืน plain text พร้อม Content-Disposition header", async () => {
    const { app, auth, deploymentId, insertBuildLog } = await setup();
    insertBuildLog(1, "hello world");

    const res = await app.handle(
      auth(new Request(`http://localhost/api/v1/deployments/${deploymentId}/logs/download`)),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-disposition")).toContain("attachment");

    const text = await res.text();
    expect(text).toContain("hello world");
    expect(text).toContain("stdout");
  });

  test("download ว่างเปล่าเมื่อไม่มี log", async () => {
    const { app, auth, deploymentId } = await setup();
    const res = await app.handle(
      auth(new Request(`http://localhost/api/v1/deployments/${deploymentId}/logs/download`)),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("deployment ไม่มีอยู่ → 404", async () => {
    const { app, auth } = await setup();
    const res = await app.handle(
      auth(
        new Request(`http://localhost/api/v1/deployments/${ulid()}/logs/download`),
      ),
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Build log SSE stream — GET /deployments/:id/logs/stream
// ---------------------------------------------------------------------------

describe("GET /deployments/:id/logs/stream", () => {
  test("คืน 200 พร้อม text/event-stream header", async () => {
    const { app, auth, deploymentId } = await setup();
    const res = await app.handle(
      auth(new Request(`http://localhost/api/v1/deployments/${deploymentId}/logs/stream`)),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });

  test("deployment ไม่มีอยู่ → 404", async () => {
    const { app, auth } = await setup();
    const res = await app.handle(
      auth(new Request(`http://localhost/api/v1/deployments/${ulid()}/logs/stream`)),
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Runtime logs — GET /projects/:id/runtime-logs
// ---------------------------------------------------------------------------

describe("GET /projects/:id/runtime-logs", () => {
  test("คืน empty array เมื่อไม่มี log", async () => {
    const { app, auth, projectId } = await setup();
    const res = await app.handle(
      auth(new Request(`http://localhost/api/v1/projects/${projectId}/runtime-logs`)),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.logs).toEqual([]);
  });

  test("คืน runtime log rows ตาม seq", async () => {
    const { app, auth, projectId, insertRuntimeLog } = await setup();
    insertRuntimeLog(1, "runtime line 1");
    insertRuntimeLog(2, "runtime line 2");

    const body = await json(
      await app.handle(
        auth(new Request(`http://localhost/api/v1/projects/${projectId}/runtime-logs`)),
      ),
    );
    expect(body.logs).toHaveLength(2);
    expect(body.logs[0].seq).toBe(1);
    expect(body.logs[0].line).toBe("runtime line 1");
    expect(body.logs[0].containerId).toBe("c123");
  });

  test("afterSeq cursor ทำงานถูกต้อง", async () => {
    const { app, auth, projectId, insertRuntimeLog } = await setup();
    for (let i = 1; i <= 4; i++) insertRuntimeLog(i, `rl ${i}`);

    const body = await json(
      await app.handle(
        auth(new Request(`http://localhost/api/v1/projects/${projectId}/runtime-logs?afterSeq=2`)),
      ),
    );
    expect(body.logs).toHaveLength(2);
    expect(body.logs[0].seq).toBe(3);
  });

  test("project ไม่มีอยู่ → 404", async () => {
    const { app, auth } = await setup();
    const res = await app.handle(
      auth(new Request(`http://localhost/api/v1/projects/${ulid()}/runtime-logs`)),
    );
    expect(res.status).toBe(404);
  });

  test("unauthenticated → 401", async () => {
    const { app, projectId } = await setup();
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/runtime-logs`),
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Runtime log SSE — GET /projects/:id/runtime-logs/stream
// ---------------------------------------------------------------------------

describe("GET /projects/:id/runtime-logs/stream", () => {
  test("คืน 200 พร้อม text/event-stream", async () => {
    const { app, auth, projectId } = await setup();
    const res = await app.handle(
      auth(new Request(`http://localhost/api/v1/projects/${projectId}/runtime-logs/stream`)),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });
});
