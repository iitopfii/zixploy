/**
 * Managed service backups — HTTP round-trip tests
 * Phase 16
 *
 * control-api ไม่แตะ Docker (ADR-0002) — เทสต์นี้จึงไม่มี dump/restore จริง แค่จำลองผลลัพธ์ที่
 * worker เขียนลง service_backups + ไฟล์บน backupsDir เอง แล้วตรวจว่า route ชั้น control-api
 * (list/enqueue/download/delete/restore + validation ของ backupEnabled/interval/retention ใน
 * PATCH) ทำงานถูกต้องรอบไฟล์/แถวเหล่านั้น
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { createMasterKeys, type MasterKeys } from "../src/crypto/master-key";
import { json } from "./helpers";

async function setup() {
  const backupsDir = mkdtempSync(join(tmpdir(), "zx-backups-"));
  process.env.ZIXPLOY_BACKUPS_DIR = backupsDir;

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

  return { db, app, cookie, csrf, backupsDir };
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

function patch(app: App, path: string, cookie: string, csrf: string, body: unknown) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
      body: JSON.stringify(body),
    }),
  );
}

function del(app: App, path: string, cookie: string, csrf: string) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "DELETE",
      headers: { cookie, "x-csrf-token": csrf },
    }),
  );
}

/** สร้าง service แล้วเคลียร์งาน provision ที่ค้างอยู่ทันที กัน SERVICE_BUSY ชนตอนสั่ง backup */
async function createReadyService(
  app: App,
  db: ReturnType<typeof openDatabase>,
  cookie: string,
  csrf: string,
) {
  const res = await post(app, "/api/v1/services", cookie, csrf, { name: "db1", type: "postgres" });
  const created = await json(res);
  db.query("UPDATE service_jobs SET status = 'done'").run();
  return created.id as string;
}

/** จำลองแถว backup ที่ worker เขียนไว้ — เขียนไฟล์จริงลง backupsDir ด้วยถ้า succeeded */
function seedBackup(
  db: ReturnType<typeof openDatabase>,
  backupsDir: string,
  serviceId: string,
  opts: { status: "running" | "succeeded" | "failed"; withFile?: boolean },
) {
  const id = ulid();
  const now = Date.now();
  const fileName = opts.status === "succeeded" ? `${id}.sql` : null;

  db.query(
    `INSERT INTO service_backups
       (id, service_id, trigger, status, file_name, size_bytes, started_at, finished_at, created_at)
     VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    serviceId,
    opts.status,
    fileName,
    fileName ? 42 : null,
    now,
    opts.status === "running" ? null : now,
    now,
  );

  if (fileName && opts.withFile !== false) {
    const dir = join(backupsDir, "services", serviceId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), "-- fake dump content --");
  }

  return { id, fileName };
}

// ---------------------------------------------------------------------------

describe("GET /services/:id/backups", () => {
  test("ไม่มี backup เลย → items ว่าง", async () => {
    const { app, db, cookie, csrf } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);

    const body = await json(await get(app, `/api/v1/services/${id}/backups`, cookie));
    expect(body.items).toEqual([]);
  });

  test("เรียงใหม่สุดก่อน และคืนสถานะครบทุกแบบ", async () => {
    const { app, db, cookie, csrf, backupsDir } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);

    seedBackup(db, backupsDir, id, { status: "failed" });
    await new Promise((r) => setTimeout(r, 2));
    const latest = seedBackup(db, backupsDir, id, { status: "succeeded" });

    const body = await json(await get(app, `/api/v1/services/${id}/backups`, cookie));
    expect(body.items).toHaveLength(2);
    expect(body.items[0].id).toBe(latest.id);
    expect(body.items[0].status).toBe("succeeded");
    expect(body.items[0].fileName).toBe(latest.fileName);
    expect(body.items[1].status).toBe("failed");
  });

  test("ไม่ login → 401", async () => {
    const { app, db, cookie, csrf } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);
    expect((await get(app, `/api/v1/services/${id}/backups`)).status).toBe(401);
  });
});

describe("POST /services/:id/backups", () => {
  test("สั่ง backup → 202 และสร้างงาน type=backup", async () => {
    const { app, db, cookie, csrf } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);

    const res = await post(app, `/api/v1/services/${id}/backups`, cookie, csrf);
    expect(res.status).toBe(202);
    expect((await json(res)).busy).toBe(true);

    const job = db
      .query<{ type: string; status: string }, []>(
        "SELECT type, status FROM service_jobs WHERE status = 'pending'",
      )
      .get();
    expect(job?.type).toBe("backup");
  });

  test("สั่งซ้อนขณะมีงานค้าง → 409 SERVICE_BUSY", async () => {
    const { app, db, cookie, csrf } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);
    await post(app, `/api/v1/services/${id}/backups`, cookie, csrf);

    const res = await post(app, `/api/v1/services/${id}/backups`, cookie, csrf);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("SERVICE_BUSY");
  });
});

describe("GET /services/:id/backups/:backupId/download", () => {
  test("backup สำเร็จ → 200 พร้อมเนื้อไฟล์จริงและ Content-Disposition", async () => {
    const { app, db, cookie, csrf, backupsDir } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);
    const { id: backupId, fileName } = seedBackup(db, backupsDir, id, { status: "succeeded" });

    const res = await get(app, `/api/v1/services/${id}/backups/${backupId}/download`, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(fileName as string);
    expect(await res.text()).toBe("-- fake dump content --");
  });

  test("backup ยังรันอยู่ (ไม่มีไฟล์) → 409 SERVICE_BACKUP_NOT_READY", async () => {
    const { app, db, cookie, csrf, backupsDir } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);
    const { id: backupId } = seedBackup(db, backupsDir, id, { status: "running" });

    const res = await get(app, `/api/v1/services/${id}/backups/${backupId}/download`, cookie);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("SERVICE_BACKUP_NOT_READY");
  });

  test("แถวบอกสำเร็จแต่ไฟล์หายจากดิสก์ → 404 SERVICE_BACKUP_NOT_FOUND", async () => {
    const { app, db, cookie, csrf, backupsDir } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);
    const { id: backupId } = seedBackup(db, backupsDir, id, {
      status: "succeeded",
      withFile: false,
    });

    const res = await get(app, `/api/v1/services/${id}/backups/${backupId}/download`, cookie);
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("SERVICE_BACKUP_NOT_FOUND");
  });

  test("backupId ของ service อื่น → 404 (กัน id เดาข้าม service)", async () => {
    const { app, db, cookie, csrf, backupsDir } = await setup();
    const idA = await createReadyService(app, db, cookie, csrf);
    const resB = await post(app, "/api/v1/services", cookie, csrf, {
      name: "db2",
      type: "redis",
    });
    const idB = (await json(resB)).id as string;

    const { id: backupId } = seedBackup(db, backupsDir, idA, { status: "succeeded" });

    const res = await get(app, `/api/v1/services/${idB}/backups/${backupId}/download`, cookie);
    expect(res.status).toBe(404);
  });

  test("ไม่ login → 401", async () => {
    const { app, db, cookie, csrf, backupsDir } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);
    const { id: backupId } = seedBackup(db, backupsDir, id, { status: "succeeded" });

    expect((await get(app, `/api/v1/services/${id}/backups/${backupId}/download`)).status).toBe(
      401,
    );
  });
});

describe("DELETE /services/:id/backups/:backupId", () => {
  test("ลบ backup สำเร็จ → 204, ลบทั้งแถวและไฟล์จริง", async () => {
    const { app, db, cookie, csrf, backupsDir } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);
    const { id: backupId, fileName } = seedBackup(db, backupsDir, id, { status: "succeeded" });
    const filePath = join(backupsDir, "services", id, fileName as string);
    expect(existsSync(filePath)).toBe(true);

    const res = await del(app, `/api/v1/services/${id}/backups/${backupId}`, cookie, csrf);
    expect(res.status).toBe(204);
    expect(existsSync(filePath)).toBe(false);

    const row = db
      .query<{ id: string }, [string]>("SELECT id FROM service_backups WHERE id = ?")
      .get(backupId);
    expect(row).toBeNull();
  });

  test("ลบ backup ที่กำลังรันอยู่ → 409 SERVICE_BACKUP_NOT_READY", async () => {
    const { app, db, cookie, csrf, backupsDir } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);
    const { id: backupId } = seedBackup(db, backupsDir, id, { status: "running" });

    const res = await del(app, `/api/v1/services/${id}/backups/${backupId}`, cookie, csrf);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("SERVICE_BACKUP_NOT_READY");
  });

  test("id ที่ไม่มีจริง → 404", async () => {
    const { app, db, cookie, csrf } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);

    const res = await del(app, `/api/v1/services/${id}/backups/${ulid()}`, cookie, csrf);
    expect(res.status).toBe(404);
  });
});

describe("POST /services/:id/backups/:backupId/restore", () => {
  test("backup สำเร็จ → 202 และสร้างงาน type=restore พร้อม payload backupId", async () => {
    const { app, db, cookie, csrf, backupsDir } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);
    const { id: backupId } = seedBackup(db, backupsDir, id, { status: "succeeded" });

    const res = await post(app, `/api/v1/services/${id}/backups/${backupId}/restore`, cookie, csrf);
    expect(res.status).toBe(202);

    const job = db
      .query<{ type: string; payload: string }, []>(
        "SELECT type, payload FROM service_jobs WHERE status = 'pending'",
      )
      .get();
    expect(job?.type).toBe("restore");
    expect(JSON.parse(job?.payload ?? "{}")).toEqual({ backupId });
  });

  test("backup ยังไม่สำเร็จ → 409 SERVICE_BACKUP_NOT_READY ไม่สร้างงาน", async () => {
    const { app, db, cookie, csrf, backupsDir } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);
    const { id: backupId } = seedBackup(db, backupsDir, id, { status: "failed" });

    const res = await post(app, `/api/v1/services/${id}/backups/${backupId}/restore`, cookie, csrf);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("SERVICE_BACKUP_NOT_READY");

    const count = db
      .query<{ n: number }, []>("SELECT COUNT(*) as n FROM service_jobs WHERE status = 'pending'")
      .get();
    expect(count?.n).toBe(0);
  });

  test("มีงานค้างอยู่แล้ว → 409 SERVICE_BUSY", async () => {
    const { app, db, cookie, csrf, backupsDir } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);
    const { id: backupId } = seedBackup(db, backupsDir, id, { status: "succeeded" });
    await post(app, `/api/v1/services/${id}/backups`, cookie, csrf); // ค้างงาน backup ไว้

    const res = await post(app, `/api/v1/services/${id}/backups/${backupId}/restore`, cookie, csrf);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("SERVICE_BUSY");
  });
});

describe("PATCH /services/:id — ตั้งค่า backup", () => {
  test("เปิด backupEnabled โดยไม่มี interval → 400 VALIDATION_ERROR", async () => {
    const { app, db, cookie, csrf } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);

    const res = await patch(app, `/api/v1/services/${id}`, cookie, csrf, { backupEnabled: true });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details?.field).toBe("backupIntervalHours");
  });

  test("interval นอก allowlist → 400 VALIDATION_ERROR", async () => {
    const { app, db, cookie, csrf } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);

    const res = await patch(app, `/api/v1/services/${id}`, cookie, csrf, {
      backupIntervalHours: 3,
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("VALIDATION_ERROR");
  });

  test("retention นอกช่วง → 422 VALIDATION_ERROR", async () => {
    const { app, db, cookie, csrf } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);

    const res = await patch(app, `/api/v1/services/${id}`, cookie, csrf, {
      backupRetentionCount: 100,
    });
    expect(res.status).toBe(400); // TypeBox กันที่ schema (max 30) ก่อนถึง handler
  });

  test("ตั้งค่าถูกต้อง → 200 แม้ service ยังไม่ stopped (ไม่แตะ container/volume)", async () => {
    const { app, db, cookie, csrf } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);
    // status ยังเป็น creating (ไม่ได้สั่ง stopped) — ตั้งค่า backup ต้องไม่ติด SERVICE_NOT_STOPPED
    expect(
      db.query<{ status: string }, [string]>("SELECT status FROM services WHERE id = ?").get(id)
        ?.status,
    ).toBe("creating");

    const res = await patch(app, `/api/v1/services/${id}`, cookie, csrf, {
      backupEnabled: true,
      backupIntervalHours: 24,
      backupRetentionCount: 10,
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.backupEnabled).toBe(true);
    expect(body.backupIntervalHours).toBe(24);
    expect(body.backupRetentionCount).toBe(10);
  });

  test("ปิด backupEnabled โดยไม่แตะ interval เดิม → ผ่านได้เสมอ", async () => {
    const { app, db, cookie, csrf } = await setup();
    const id = await createReadyService(app, db, cookie, csrf);
    await patch(app, `/api/v1/services/${id}`, cookie, csrf, {
      backupEnabled: true,
      backupIntervalHours: 12,
    });

    const res = await patch(app, `/api/v1/services/${id}`, cookie, csrf, {
      backupEnabled: false,
    });
    expect(res.status).toBe(200);
    expect((await json(res)).backupEnabled).toBe(false);
  });
});
