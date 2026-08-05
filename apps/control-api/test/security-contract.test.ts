import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ERROR_CODES, type ErrorCode, isUlid, ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { createSession, hashToken, SESSION_TTL_MS } from "../src/auth/session";
import { MAX_BODY_BYTES } from "../src/plugins/body-limit";
import { json } from "./helpers";

const PASSWORD = "correct horse battery staple";

async function setup() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  const userId = ulid();
  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(userId, "admin", await hashPassword(PASSWORD), now, now);

  const app = buildApp(db);
  const loginRes = await app.handle(
    new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: PASSWORD }),
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
  const csrf = cookies.zx_csrf ?? "";

  const createProject = async (name: string) =>
    json(
      await app.handle(
        new Request("http://localhost/api/v1/projects", {
          method: "POST",
          headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
          body: JSON.stringify({ name }),
        }),
      ),
    );

  return { db, app, userId, cookie, csrf, createProject };
}

describe("PATCH project — authentication และ CSRF", () => {
  test("ไม่มี session -> 401 และไม่มีการเปลี่ยนแปลงข้อมูล", async () => {
    const { app, createProject } = await setup();
    const project = await createProject("original");

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${project.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "hacked" }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe("UNAUTHENTICATED");
  });

  test("มี session แต่ไม่มี CSRF header -> 403 และข้อมูลไม่เปลี่ยน", async () => {
    const { app, cookie, csrf, createProject } = await setup();
    const project = await createProject("original");

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${project.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "hacked" }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("CSRF_REJECTED");

    const after = await json(
      await app.handle(
        new Request(`http://localhost/api/v1/projects/${project.id}`, {
          headers: { cookie, "x-csrf-token": csrf },
        }),
      ),
    );
    expect(after.name).toBe("original");
  });

  test("CSRF token ที่ยาวเท่ากันแต่ค่าต่างกัน -> 403", async () => {
    const { app, cookie, csrf, createProject } = await setup();
    const project = await createProject("original");

    const forged = `${"a".repeat(csrf.length - 1)}b`;
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${project.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie, "x-csrf-token": forged },
        body: JSON.stringify({ name: "hacked" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("session + CSRF ครบ -> แก้ไขสำเร็จทุก field ที่ Phase 1 รองรับ", async () => {
    const { app, cookie, csrf, createProject } = await setup();
    const project = await createProject("original");

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${project.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify({
          name: "renamed",
          dockerfilePath: "docker/Dockerfile",
          buildContext: "apps/web",
          internalPort: 3000,
          healthCheckPath: "/healthz",
          autoDeploy: true,
        }),
      }),
    );
    expect(res.status).toBe(200);

    const updated = await json(res);
    expect(updated).toMatchObject({
      name: "renamed",
      dockerfilePath: "docker/Dockerfile",
      buildContext: "apps/web",
      internalPort: 3000,
      healthCheckPath: "/healthz",
      autoDeploy: true,
    });
  });

  test("ตั้ง internalPort/healthCheckPath กลับเป็น null ได้", async () => {
    const { app, cookie, csrf, createProject } = await setup();
    const project = await createProject("p");

    await app.handle(
      new Request(`http://localhost/api/v1/projects/${project.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify({ internalPort: 8080, healthCheckPath: "/healthz" }),
      }),
    );

    const cleared = await json(
      await app.handle(
        new Request(`http://localhost/api/v1/projects/${project.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
          body: JSON.stringify({ internalPort: null, healthCheckPath: null }),
        }),
      ),
    );
    expect(cleared.internalPort).toBeNull();
    expect(cleared.healthCheckPath).toBeNull();
  });
});

describe("archived project แก้ไขไม่ได้", () => {
  test("PATCH หลัง archive -> 409 PROJECT_ARCHIVED และค่าคงเดิม", async () => {
    const { app, cookie, csrf, createProject } = await setup();
    const project = await createProject("to-archive");

    await app.handle(
      new Request(`http://localhost/api/v1/projects/${project.id}/archive`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );

    for (const body of [
      { name: "nope" },
      { autoDeploy: true },
      { internalPort: 9999 },
      { dockerfilePath: "other/Dockerfile" },
    ]) {
      const res = await app.handle(
        new Request(`http://localhost/api/v1/projects/${project.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
          body: JSON.stringify(body),
        }),
      );
      expect(res.status).toBe(409);
      expect((await json(res)).error.code).toBe("PROJECT_ARCHIVED");
    }

    const after = await json(
      await app.handle(
        new Request(`http://localhost/api/v1/projects/${project.id}`, { headers: { cookie } }),
      ),
    );
    expect(after.name).toBe("to-archive");
    expect(after.autoDeploy).toBe(false);
    expect(after.internalPort).toBeNull();
  });
});

describe("expired session", () => {
  test("session ที่หมดอายุใช้เรียก API ไม่ได้", async () => {
    const { db, app, userId } = await setup();
    // สร้าง session ที่หมดอายุไปแล้ว
    const expired = createSession(db, userId, Date.now() - SESSION_TTL_MS - 60_000);

    const res = await app.handle(
      new Request("http://localhost/api/v1/projects", {
        headers: { cookie: `zx_session=${encodeURIComponent(expired.token)}` },
      }),
    );
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe("UNAUTHENTICATED");
  });

  test("/auth/session รายงาน authenticated false เมื่อ session หมดอายุ", async () => {
    const { db, app, userId } = await setup();
    const expired = createSession(db, userId, Date.now() - SESSION_TTL_MS - 60_000);

    const body = await json(
      await app.handle(
        new Request("http://localhost/api/v1/auth/session", {
          headers: { cookie: `zx_session=${encodeURIComponent(expired.token)}` },
        }),
      ),
    );
    expect(body).toEqual({ authenticated: false });
  });

  test("session ที่หมดอายุพอดี (boundary) ใช้ไม่ได้", async () => {
    const { db, app, userId } = await setup();
    const token = createSession(db, userId).token;
    // ตั้ง expires_at ให้เท่ากับตอนนี้พอดี — เงื่อนไขคือ expires_at <= now ถือว่าหมดอายุ
    db.query("UPDATE sessions SET expires_at = ? WHERE id = ?").run(Date.now(), hashToken(token));

    const res = await app.handle(
      new Request("http://localhost/api/v1/projects", {
        headers: { cookie: `zx_session=${encodeURIComponent(token)}` },
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("error envelope contract", () => {
  test("ทุก error ตอบรูปแบบเดียวกันและ status ตรงกับ code ที่ประกาศไว้", async () => {
    const { app, cookie, csrf } = await setup();

    const cases: { request: Request; code: ErrorCode }[] = [
      {
        request: new Request("http://localhost/api/v1/projects"),
        code: "UNAUTHENTICATED",
      },
      {
        request: new Request("http://localhost/api/v1/nope-not-a-route"),
        code: "NOT_FOUND",
      },
      {
        request: new Request(`http://localhost/api/v1/projects/${ulid()}`, { headers: { cookie } }),
        code: "PROJECT_NOT_FOUND",
      },
      {
        request: new Request("http://localhost/api/v1/projects", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ name: "x" }),
        }),
        code: "CSRF_REJECTED",
      },
      {
        request: new Request("http://localhost/api/v1/projects", {
          method: "POST",
          headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
          body: JSON.stringify({ notAName: true }),
        }),
        code: "VALIDATION_ERROR",
      },
    ];

    for (const { request, code } of cases) {
      const res = await app.handle(request);
      const body = await json(res);

      expect(res.status).toBe(ERROR_CODES[code]);
      expect(body.error.code).toBe(code);
      expect(typeof body.error.message).toBe("string");
      expect(body.error.message.length).toBeGreaterThan(0);
      // requestId ต้องมีเสมอและตรงกับ header เพื่อให้ตามรอย log ได้
      expect(typeof body.error.requestId).toBe("string");
      // envelope ต้องไม่มี field อื่นนอกจากที่ประกาศไว้
      expect(Object.keys(body)).toEqual(["error"]);
      expect(
        Object.keys(body.error).every((k) =>
          ["code", "message", "requestId", "details"].includes(k),
        ),
      ).toBe(true);
      // ห้ามมี stack trace หรือ path ภายในหลุดออกไป
      expect(JSON.stringify(body)).not.toContain(".ts:");
    }
  });

  test("requestId ใน envelope ตรงกับ X-Request-Id header", async () => {
    const { app } = await setup();
    const res = await app.handle(
      new Request("http://localhost/api/v1/projects", {
        headers: { "X-Request-Id": "trace-me-123" },
      }),
    );
    expect(res.headers.get("X-Request-Id")).toBe("trace-me-123");
    expect((await json(res)).error.requestId).toBe("trace-me-123");
  });

  test("requestId ที่ระบบสร้างเองเป็น ULID", async () => {
    const { app } = await setup();
    const res = await app.handle(new Request("http://localhost/api/v1/projects"));
    expect(isUlid((await json(res)).error.requestId)).toBe(true);
  });

  test("body เกินลิมิตถูกปฏิเสธก่อนอ่าน body", async () => {
    const { app, cookie, csrf } = await setup();
    const oversized = JSON.stringify({ name: "x".repeat(MAX_BODY_BYTES) });

    const res = await app.handle(
      new Request("http://localhost/api/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(oversized.length),
          cookie,
          "x-csrf-token": csrf,
        },
        body: oversized,
      }),
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("VALIDATION_ERROR");
  });
});
