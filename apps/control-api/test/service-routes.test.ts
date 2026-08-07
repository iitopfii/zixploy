/**
 * Managed Service Routes — HTTP round-trip tests
 * Phase 10 M2
 *
 * ครอบคลุม:
 * - catalog listing ตรงกับ SERVICE_TYPES (กัน schema กับ catalog หลุดจากกัน)
 * - create → enqueue provision job, สถานะเริ่มต้น creating
 * - รหัสผ่านไม่โผล่ใน list/detail — ต้องเรียก /credentials เท่านั้น
 * - รหัสผ่านที่เก็บถูกเข้ารหัสจริง (BLOB ไม่มี plaintext)
 * - port validation: นอกช่วง / reserved / ซ้ำ
 * - ชื่อซ้ำ → 409
 * - version นอก allowlist → 422
 * - lifecycle ops สร้างงานให้ worker และกันงานซ้อน (SERVICE_BUSY)
 * - unauthenticated → 401
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { SERVICE_SETTINGS, SERVICE_TYPES, ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { createMasterKeys, type MasterKeys } from "../src/crypto/master-key";
import { json } from "./helpers";

async function setup() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));

  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)",
  ).run(ulid(), await hashPassword("adminpass123"), now, now);

  const masterKeys: MasterKeys = await createMasterKeys(1, { 1: new Uint8Array(32).fill(0x2b) });
  const app = buildApp(db, { masterKeys });

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
  const csrf = cookies.zx_csrf ?? "";

  return { db, app, cookie, csrf };
}

type App = Awaited<ReturnType<typeof setup>>["app"];

function get(app: App, path: string, cookie?: string) {
  return app.handle(new Request(`http://localhost${path}`, { headers: cookie ? { cookie } : {} }));
}

function post(app: App, path: string, cookie: string, csrf: string, body?: unknown) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

function createSvc(app: App, cookie: string, csrf: string, body: Record<string, unknown>) {
  return post(app, "/api/v1/services", cookie, csrf, body);
}

// ---------------------------------------------------------------------------

describe("GET /service-catalog", () => {
  test("คืน template ครบทุกชนิดใน SERVICE_TYPES", async () => {
    const { app, cookie } = await setup();
    const body = await json(await get(app, "/api/v1/service-catalog", cookie));

    const types = body.items.map((i: { type: string }) => i.type).sort();
    expect(types).toEqual([...SERVICE_TYPES].sort());
  });

  test("ทุก entry มี defaultVersion อยู่ใน versions", async () => {
    const { app, cookie } = await setup();
    const body = await json(await get(app, "/api/v1/service-catalog", cookie));
    for (const item of body.items) {
      expect(item.versions).toContain(item.defaultVersion);
    }
  });

  test("ไม่ login → 401", async () => {
    const { app } = await setup();
    expect((await get(app, "/api/v1/service-catalog")).status).toBe(401);
  });
});

describe("POST /services", () => {
  test("สร้างสำเร็จ → 201, status=creating, busy=true (มีงาน provision รออยู่)", async () => {
    const { app, cookie, csrf } = await setup();
    const res = await createSvc(app, cookie, csrf, { name: "maindb", type: "postgres" });
    expect(res.status).toBe(201);

    const body = await json(res);
    expect(body.name).toBe("maindb");
    expect(body.status).toBe("creating");
    expect(body.busy).toBe(true);
    expect(body.image).toStartWith("postgres:");
  });

  test("สร้างงาน provision ให้ worker หนึ่งงาน", async () => {
    const { app, db, cookie, csrf } = await setup();
    await createSvc(app, cookie, csrf, { name: "db1", type: "redis" });

    const jobs = db
      .query<{ type: string; status: string }, []>("SELECT type, status FROM service_jobs")
      .all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.type).toBe("provision");
    expect(jobs[0]?.status).toBe("pending");
  });

  test("รหัสผ่านถูกเข้ารหัส — BLOB ไม่มี plaintext และ response ไม่มีรหัสผ่าน", async () => {
    const { app, db, cookie, csrf } = await setup();
    const created = await json(
      await createSvc(app, cookie, csrf, { name: "sec", type: "postgres" }),
    );

    // response ของ create ต้องไม่มี field รหัสผ่านเลย
    expect(JSON.stringify(created)).not.toContain("password");

    const row = db
      .query<{ password_enc: Uint8Array }, [string]>(
        "SELECT password_enc FROM services WHERE id = ?",
      )
      .get(created.id);
    expect(row?.password_enc).toBeInstanceOf(Uint8Array);

    // ดึงรหัสผ่านจริงมาเทียบว่าไม่ได้อยู่ใน BLOB แบบ plaintext
    const creds = await json(await get(app, `/api/v1/services/${created.id}/credentials`, cookie));
    expect(creds.password.length).toBe(SERVICE_SETTINGS.passwordLength);
    const blobAsText = new TextDecoder().decode(row?.password_enc ?? new Uint8Array());
    expect(blobAsText).not.toContain(creds.password);
  });

  test("ชื่อซ้ำ → 409", async () => {
    const { app, cookie, csrf } = await setup();
    await createSvc(app, cookie, csrf, { name: "dup", type: "postgres" });
    const res = await createSvc(app, cookie, csrf, { name: "dup", type: "redis" });
    expect(res.status).toBe(409);
  });

  test("version นอก allowlist → 422", async () => {
    const { app, cookie, csrf } = await setup();
    const res = await createSvc(app, cookie, csrf, {
      name: "old",
      type: "postgres",
      version: "9.6",
    });
    expect(res.status).toBe(422);
  });

  test("type ที่ไม่มีใน catalog → 400 (schema ปฏิเสธก่อนถึง handler)", async () => {
    const { app, cookie, csrf } = await setup();
    const res = await createSvc(app, cookie, csrf, { name: "x", type: "oracle" });
    expect(res.status).toBe(400);
  });

  // 3001 คือ control-api เอง — เปิดทับจะทำให้ dashboard ต่อ API ไม่ได้ทั้งระบบ
  // (80/443/22 ถูกกันด้วย range check ที่ min 1024 อยู่แล้ว จึงไม่มาถึงชั้นนี้)
  test("port ที่ระบบใช้อยู่ (3001) → 422 SERVICE_PORT_RESERVED", async () => {
    const { app, cookie, csrf } = await setup();
    const res = await createSvc(app, cookie, csrf, {
      name: "p",
      type: "postgres",
      exposedPort: 3001,
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe("SERVICE_PORT_RESERVED");
  });

  test("port 80 ติด range check ก่อน (ต่ำกว่า 1024) — ยังถูกปฏิเสธเช่นกัน", async () => {
    const { app, cookie, csrf } = await setup();
    const res = await createSvc(app, cookie, csrf, {
      name: "p80",
      type: "postgres",
      exposedPort: 80,
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe("SERVICE_PORT_OUT_OF_RANGE");
  });

  test("port ต่ำกว่าช่วงที่อนุญาต → 422 SERVICE_PORT_OUT_OF_RANGE", async () => {
    const { app, cookie, csrf } = await setup();
    const res = await createSvc(app, cookie, csrf, {
      name: "p2",
      type: "postgres",
      exposedPort: 100,
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe("SERVICE_PORT_OUT_OF_RANGE");
  });

  test("port ซ้ำกับ service อื่น → 409 SERVICE_PORT_IN_USE", async () => {
    const { app, cookie, csrf } = await setup();
    await createSvc(app, cookie, csrf, { name: "a", type: "postgres", exposedPort: 5433 });
    const res = await createSvc(app, cookie, csrf, {
      name: "b",
      type: "mysql",
      exposedPort: 5433,
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("SERVICE_PORT_IN_USE");
  });

  test("ไม่เปิด port → exposedPort เป็น null (default ที่ปลอดภัย)", async () => {
    const { app, cookie, csrf } = await setup();
    const body = await json(await createSvc(app, cookie, csrf, { name: "int", type: "mongodb" }));
    expect(body.exposedPort).toBeNull();
  });
});

describe("GET /services + /services/:id", () => {
  test("list ไม่มีรหัสผ่าน", async () => {
    const { app, cookie, csrf } = await setup();
    await createSvc(app, cookie, csrf, { name: "l1", type: "postgres" });

    const body = await json(await get(app, "/api/v1/services", cookie));
    expect(body.items).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("password");
  });

  test("id ที่ไม่มีจริง → 404", async () => {
    const { app, cookie } = await setup();
    expect((await get(app, `/api/v1/services/${ulid()}`, cookie)).status).toBe(404);
  });

  test("id ไม่ใช่ ULID → 404", async () => {
    const { app, cookie } = await setup();
    expect((await get(app, "/api/v1/services/not-ulid", cookie)).status).toBe(404);
  });
});

describe("GET /services/:id/credentials", () => {
  test("คืน connection string ภายในที่ประกอบถูกต้อง", async () => {
    const { app, cookie, csrf } = await setup();
    const created = await json(
      await createSvc(app, cookie, csrf, { name: "pg", type: "postgres" }),
    );
    const creds = await json(await get(app, `/api/v1/services/${created.id}/credentials`, cookie));

    expect(creds.internalUri).toStartWith("postgresql://");
    expect(creds.internalUri).toContain(creds.username);
    expect(creds.internalPort).toBe(5432);
    // ไม่เปิด port ภายนอก → ไม่มี externalUri
    expect(creds.externalUri).toBeNull();
  });

  test("เปิด port ภายนอก → มี externalUri พร้อม placeholder ให้เติม IP", async () => {
    const { app, cookie, csrf } = await setup();
    const created = await json(
      await createSvc(app, cookie, csrf, { name: "ext", type: "postgres", exposedPort: 5555 }),
    );
    const creds = await json(await get(app, `/api/v1/services/${created.id}/credentials`, cookie));

    expect(creds.externalUri).toContain("<SERVER_IP>");
    expect(creds.externalUri).toContain(":5555");
  });

  test("ไม่ login → 401 (รหัสผ่านไม่หลุดให้คนที่ไม่ได้ยืนยันตัวตน)", async () => {
    const { app, cookie, csrf } = await setup();
    const created = await json(await createSvc(app, cookie, csrf, { name: "s", type: "redis" }));
    expect((await get(app, `/api/v1/services/${created.id}/credentials`)).status).toBe(401);
  });
});

describe("lifecycle operations", () => {
  test("start/stop/restart สร้างงานให้ worker", async () => {
    const { app, db, cookie, csrf } = await setup();
    const created = await json(await createSvc(app, cookie, csrf, { name: "ops", type: "redis" }));

    // เคลียร์งาน provision ก่อน ไม่งั้นชน unique index (หนึ่งงานค้างต่อ service)
    db.query("UPDATE service_jobs SET status = 'done'").run();

    const res = await post(app, `/api/v1/services/${created.id}/restart`, cookie, csrf);
    expect(res.status).toBe(202);

    const job = db
      .query<{ type: string }, []>(
        "SELECT type FROM service_jobs WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1",
      )
      .get();
    expect(job?.type).toBe("restart");
  });

  test("สั่งงานซ้อนขณะมีงานค้าง → 409 SERVICE_BUSY", async () => {
    const { app, cookie, csrf } = await setup();
    const created = await json(await createSvc(app, cookie, csrf, { name: "busy", type: "redis" }));

    // provision ยังค้างอยู่ — สั่ง restart ทับไม่ได้
    const res = await post(app, `/api/v1/services/${created.id}/restart`, cookie, csrf);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("SERVICE_BUSY");
  });

  test("DELETE ตั้ง status=deleting และสร้างงาน destroy", async () => {
    const { app, db, cookie, csrf } = await setup();
    const created = await json(await createSvc(app, cookie, csrf, { name: "del", type: "mysql" }));
    db.query("UPDATE service_jobs SET status = 'done'").run();

    const res = await app.handle(
      new Request(`http://localhost/api/v1/services/${created.id}`, {
        method: "DELETE",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(res.status).toBe(202);
    expect((await json(res)).status).toBe("deleting");

    const job = db
      .query<{ type: string }, []>("SELECT type FROM service_jobs WHERE status = 'pending'")
      .get();
    expect(job?.type).toBe("destroy");
  });
});

describe("PATCH /services/:id", () => {
  test("แก้ port ขณะยังไม่ stopped → 409 SERVICE_NOT_STOPPED", async () => {
    const { app, cookie, csrf } = await setup();
    const created = await json(
      await createSvc(app, cookie, csrf, { name: "up", type: "postgres" }),
    );

    const res = await app.handle(
      new Request(`http://localhost/api/v1/services/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify({ exposedPort: 5566 }),
      }),
    );
    expect(res.status).toBe(409);
  });

  test("แก้ได้เมื่อ stopped", async () => {
    const { app, db, cookie, csrf } = await setup();
    const created = await json(
      await createSvc(app, cookie, csrf, { name: "up2", type: "postgres" }),
    );
    db.query("UPDATE services SET status = 'stopped' WHERE id = ?").run(created.id);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/services/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify({ exposedPort: 5567 }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await json(res)).exposedPort).toBe(5567);
  });
});
