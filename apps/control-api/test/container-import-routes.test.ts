/**
 * Container import API — ขอ/ดู/ยืนยันการนำเข้า container ที่มีอยู่แล้ว
 *
 * control-api ไม่แตะ Docker เลย (ADR-0002) — endpoint เหล่านี้แค่บันทึกคำขอลง DB ให้ worker ทำต่อ
 * จุดที่ต้องกันให้แน่น: ต้อง auth, ห้ามนำเข้า container ของ Zixploy เอง, และ response ต้องไม่มี
 * ค่าของ env (มีแค่ชื่อ key)
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { json } from "./helpers";

async function login(app: ReturnType<typeof buildApp>) {
  const res = await app.handle(
    new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "adminpass123" }),
    }),
  );
  const cookies: Record<string, string> = {};
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (pair && eq > 0) cookies[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
  return { cookie, csrf: cookies.zx_csrf ?? "" };
}

async function setup() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)",
  ).run(ulid(), await hashPassword("adminpass123"), now, now);

  // inventory snapshot: container ของผู้ใช้เอง + ของ Zixploy
  const ins = db.query(
    `INSERT INTO docker_containers
       (container_id, name, image, state, status, is_managed, captured_at)
     VALUES (?, ?, ?, 'running', 'Up 2 hours', ?, ?)`,
  );
  ins.run("aabbccddeeff", "my-legacy-app", "nginx:1.27", 0, now);
  ins.run("112233445566", "zixploy-control-api", "zixploy/control-api:local", 1, now);

  const app = buildApp(db, { masterKeys: null });
  const { cookie, csrf } = await login(app);
  return { db, app, cookie, csrf };
}

function post(
  app: ReturnType<typeof buildApp>,
  path: string,
  cookie: string,
  csrf: string,
  body?: unknown,
) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
  );
}

const IMPORT_PATH = "/api/v1/system/docker/containers/aabbccddeeff/import";

describe("POST /system/docker/containers/:id/import", () => {
  test("ไม่ login → 401 และไม่มีคำขอถูกสร้าง", async () => {
    const { db, app } = await setup();
    const res = await app.handle(new Request(`http://localhost${IMPORT_PATH}`, { method: "POST" }));
    expect(res.status).toBe(401);
    const count = db.query("SELECT count(*) c FROM container_imports").get() as { c: number };
    expect(count.c).toBe(0);
  });

  test("container ของผู้ใช้เอง → 202 พร้อมสถานะ pending (รอ worker อ่าน config)", async () => {
    const { app, cookie, csrf } = await setup();
    const res = await post(app, IMPORT_PATH, cookie, csrf);
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body.status).toBe("pending");
    expect(body.containerName).toBe("my-legacy-app");
    expect(body.envKeys).toEqual([]); // ยังไม่ได้ inspect
  });

  test("container ของ Zixploy เอง → ปฏิเสธ (ไม่ต้องนำเข้า)", async () => {
    const { app, cookie, csrf } = await setup();
    const res = await post(
      app,
      "/api/v1/system/docker/containers/112233445566/import",
      cookie,
      csrf,
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toContain("จัดการโดย Zixploy อยู่แล้ว");
  });

  test("container id ผิดรูปแบบ → ปฏิเสธตั้งแต่ต้นทาง", async () => {
    const { app, cookie, csrf } = await setup();
    const res = await post(
      app,
      "/api/v1/system/docker/containers/not-a-hex-id/import",
      cookie,
      csrf,
    );
    expect(res.status).toBe(400);
  });

  test("container ที่ไม่มีในรายการล่าสุด → บอกให้รอ worker กวาดข้อมูล", async () => {
    const { app, cookie, csrf } = await setup();
    const res = await post(
      app,
      "/api/v1/system/docker/containers/ffffffffffff/import",
      cookie,
      csrf,
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toContain("รอ worker");
  });
});

describe("GET + confirm", () => {
  async function seedInspected(db: ReturnType<typeof openDatabase>) {
    const id = ulid();
    const now = Date.now();
    db.query(
      `INSERT INTO container_imports
         (id, container_id, container_name, status, image, command, restart_policy,
          env_keys, ports, mounts, created_at, updated_at)
       VALUES (?, 'aabbccddeeff', 'my-legacy-app', 'inspected', 'nginx:1.27', 'nginx -g daemon off;',
               'always', ?, ?, ?, ?, ?)`,
    ).run(
      id,
      JSON.stringify(["APP_KEY", "PORT"]),
      JSON.stringify([{ hostPort: 8080, containerPort: 80 }]),
      JSON.stringify([{ source: "appdata", target: "/data", type: "volume", readOnly: false }]),
      now,
      now,
    );
    return id;
  }

  test("GET คืน config ที่อ่านมา — มีแต่ชื่อ env ไม่มีค่า", async () => {
    const { db, app, cookie } = await setup();
    const id = await seedInspected(db);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/system/docker/imports/${id}`, { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe("inspected");
    expect(body.image).toBe("nginx:1.27");
    expect(body.envKeys).toEqual(["APP_KEY", "PORT"]);
    expect(body.ports).toEqual([{ hostPort: 8080, containerPort: 80 }]);
    expect(body.mounts[0].target).toBe("/data");
    // schema ไม่มีช่องให้ค่า env เลย
    expect(JSON.stringify(body)).not.toContain("envValues");
  });

  test("confirm → สถานะเป็น confirmed พร้อมชื่อ project ที่ตั้ง (worker ทำต่อ)", async () => {
    const { db, app, cookie, csrf } = await setup();
    const id = await seedInspected(db);

    const res = await post(app, `/api/v1/system/docker/imports/${id}/confirm`, cookie, csrf, {
      projectName: "legacy-app",
    });
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body.status).toBe("confirmed");
    expect(body.projectName).toBe("legacy-app");
  });

  test("confirm ซ้ำ → ปฏิเสธ (กันสร้าง project ซ้ำจากคำขอเดียว)", async () => {
    const { db, app, cookie, csrf } = await setup();
    const id = await seedInspected(db);

    await post(app, `/api/v1/system/docker/imports/${id}/confirm`, cookie, csrf, {});
    const again = await post(app, `/api/v1/system/docker/imports/${id}/confirm`, cookie, csrf, {});
    expect(again.status).toBe(400);
  });

  test("confirm ตอนยังอ่าน config ไม่เสร็จ → ปฏิเสธ", async () => {
    const { db, app, cookie, csrf } = await setup();
    const id = ulid();
    const now = Date.now();
    db.query(
      `INSERT INTO container_imports (id, container_id, container_name, status, created_at, updated_at)
       VALUES (?, 'aabbccddeeff', 'my-legacy-app', 'pending', ?, ?)`,
    ).run(id, now, now);

    const res = await post(app, `/api/v1/system/docker/imports/${id}/confirm`, cookie, csrf, {});
    expect(res.status).toBe(400);
  });

  test("confirm ต้องมี CSRF", async () => {
    const { db, app, cookie } = await setup();
    const id = await seedInspected(db);
    const res = await app.handle(
      new Request(`http://localhost/api/v1/system/docker/imports/${id}/confirm`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
  });
});
