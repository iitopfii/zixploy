/**
 * Maintenance + project deployment-status API tests — Phase 11
 *
 * ครอบคลุม:
 * - POST /system/maintenance/cleanup สร้างงานให้ worker และกันงานซ้อน
 * - GET /system/maintenance คืนงานที่ค้าง + ประวัติ
 * - projects list คืน activeDeployment/lastDeploymentStatus ถูกต้อง
 *   (บั๊กเดิม: การ์ด "กำลัง deploy" นับจาก project.status ซึ่งไม่เคยเป็น 'deploying')
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { json } from "./helpers";

async function setup() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));

  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)",
  ).run(ulid(), await hashPassword("adminpass123"), now, now);

  const projectId = ulid();
  db.query(
    `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'proj', 'stopped', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(projectId, now, now);

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

  return { db, app, cookie, csrf: cookies.zx_csrf ?? "", projectId, now };
}

type App = Awaited<ReturnType<typeof setup>>["app"];
type Db = Awaited<ReturnType<typeof setup>>["db"];

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

function insertDeployment(db: Db, projectId: string, status: string, sha: string, at: number) {
  db.query(
    `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
     VALUES (?, ?, ?, 'manual', ?, ?, ?, ?)`,
  ).run(ulid(), projectId, status, sha, at, at, at);
}

// ---------------------------------------------------------------------------

describe("POST /system/maintenance/cleanup", () => {
  test("สร้างงาน prune → 202 status=pending", async () => {
    const { app, cookie, csrf } = await setup();
    const res = await post(app, "/api/v1/system/maintenance/cleanup", cookie, csrf, {});
    expect(res.status).toBe(202);

    const body = await json(res);
    expect(body.status).toBe("pending");
    expect(body.type).toBe("prune_all");
  });

  test("เลือกชนิดได้", async () => {
    const { app, cookie, csrf } = await setup();
    const body = await json(
      await post(app, "/api/v1/system/maintenance/cleanup", cookie, csrf, {
        type: "prune_build_cache",
      }),
    );
    expect(body.type).toBe("prune_build_cache");
  });

  test("สั่งซ้อนขณะมีงานค้าง → 409 MAINTENANCE_BUSY", async () => {
    const { app, cookie, csrf } = await setup();
    await post(app, "/api/v1/system/maintenance/cleanup", cookie, csrf, {});
    const res = await post(app, "/api/v1/system/maintenance/cleanup", cookie, csrf, {});
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("MAINTENANCE_BUSY");
  });

  test("งานเดิมจบแล้วสั่งใหม่ได้", async () => {
    const { app, db, cookie, csrf } = await setup();
    await post(app, "/api/v1/system/maintenance/cleanup", cookie, csrf, {});
    db.query("UPDATE maintenance_jobs SET status = 'done'").run();

    const res = await post(app, "/api/v1/system/maintenance/cleanup", cookie, csrf, {});
    expect(res.status).toBe(202);
  });

  test("ชนิดที่ไม่รู้จัก → 400", async () => {
    const { app, cookie, csrf } = await setup();
    const res = await post(app, "/api/v1/system/maintenance/cleanup", cookie, csrf, {
      type: "rm -rf",
    });
    expect(res.status).toBe(400);
  });

  // ต้องส่ง body ที่ผ่าน schema ไม่งั้นได้ 400 จาก validation ก่อนถึง auth guard
  test("ไม่ login → 401", async () => {
    const { app } = await setup();
    const res = await app.handle(
      new Request("http://localhost/api/v1/system/maintenance/cleanup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "prune_all" }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /system/maintenance", () => {
  test("ไม่มีงาน → active เป็น null", async () => {
    const { app, cookie } = await setup();
    const body = await json(await get(app, "/api/v1/system/maintenance", cookie));
    expect(body.active).toBeNull();
    expect(body.recent).toEqual([]);
  });

  test("มีงานค้าง → active ไม่เป็น null", async () => {
    const { app, cookie, csrf } = await setup();
    await post(app, "/api/v1/system/maintenance/cleanup", cookie, csrf, {});

    const body = await json(await get(app, "/api/v1/system/maintenance", cookie));
    expect(body.active).not.toBeNull();
    expect(body.active.status).toBe("pending");
  });

  test("งานที่จบแล้วอยู่ใน recent พร้อมผลลัพธ์", async () => {
    const { app, db, cookie, csrf } = await setup();
    await post(app, "/api/v1/system/maintenance/cleanup", cookie, csrf, {});
    db.query(
      "UPDATE maintenance_jobs SET status='done', reclaimed_bytes=1048576, summary='build cache 1 MB', finished_at=?",
    ).run(Date.now());

    const body = await json(await get(app, "/api/v1/system/maintenance", cookie));
    expect(body.active).toBeNull();
    expect(body.recent[0].reclaimedBytes).toBe(1048576);
    expect(body.recent[0].summary).toBe("build cache 1 MB");
  });
});

// ---------------------------------------------------------------------------
// activeDeployment — บั๊กที่ทำให้การ์ด "กำลัง deploy" เป็น 0 ตลอด
// ---------------------------------------------------------------------------

describe("projects list — activeDeployment", () => {
  test("ไม่มี deployment → activeDeployment เป็น null", async () => {
    const { app, cookie } = await setup();
    const body = await json(await get(app, "/api/v1/projects", cookie));
    expect(body.items[0].activeDeployment).toBeNull();
    expect(body.items[0].lastDeploymentStatus).toBeNull();
  });

  test("deployment ที่ยัง building → activeDeployment มีค่า แม้ project.status เป็น stopped", async () => {
    const { app, db, cookie, projectId, now } = await setup();
    insertDeployment(db, projectId, "building", "32cd3f5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", now);

    const body = await json(await get(app, "/api/v1/projects", cookie));
    const p = body.items[0];
    // project ยังเป็น stopped (แอปเวอร์ชันเดิมไม่ได้รันอยู่) แต่ build กำลังทำงาน
    expect(p.status).toBe("stopped");
    expect(p.activeDeployment).not.toBeNull();
    expect(p.activeDeployment.status).toBe("building");
    expect(p.activeDeployment.commitSha).toBe("32cd3f5");
  });

  test("deployment ที่จบแล้วไม่นับเป็น active", async () => {
    const { app, db, cookie, projectId, now } = await setup();
    insertDeployment(db, projectId, "succeeded", "aaaaaaa000000000000000000000000000000000", now);

    const body = await json(await get(app, "/api/v1/projects", cookie));
    expect(body.items[0].activeDeployment).toBeNull();
    expect(body.items[0].lastDeploymentStatus).toBe("succeeded");
  });

  test("lastDeploymentStatus = failed เมื่อ deploy ล่าสุดพัง (ใช้นับ 'ต้องดูแล')", async () => {
    const { app, db, cookie, projectId, now } = await setup();
    insertDeployment(
      db,
      projectId,
      "succeeded",
      "aaaaaaa000000000000000000000000000000000",
      now - 5000,
    );
    insertDeployment(db, projectId, "failed", "bbbbbbb000000000000000000000000000000000", now);

    const body = await json(await get(app, "/api/v1/projects", cookie));
    expect(body.items[0].lastDeploymentStatus).toBe("failed");
  });

  test("มีทั้ง in-flight และประวัติ — แยกกันถูกต้อง", async () => {
    const { app, db, cookie, projectId, now } = await setup();
    insertDeployment(
      db,
      projectId,
      "failed",
      "old0000000000000000000000000000000000000",
      now - 9000,
    );
    insertDeployment(db, projectId, "queued", "new0000000000000000000000000000000000000", now);

    const body = await json(await get(app, "/api/v1/projects", cookie));
    const p = body.items[0];
    expect(p.activeDeployment.status).toBe("queued");
    expect(p.lastDeploymentStatus).toBe("failed");
  });

  test("GET /projects/:id ก็คืน field เดียวกัน", async () => {
    const { app, db, cookie, projectId, now } = await setup();
    insertDeployment(db, projectId, "starting", "ccccccc000000000000000000000000000000000", now);

    const body = await json(await get(app, `/api/v1/projects/${projectId}`, cookie));
    expect(body.activeDeployment.status).toBe("starting");
  });

  test("deployment ของ project อื่นไม่ปน", async () => {
    const { app, db, cookie, projectId, now } = await setup();
    const otherId = ulid();
    db.query(
      `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
       VALUES (?, 'other', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
    ).run(otherId, now, now);
    insertDeployment(db, otherId, "building", "ddddddd000000000000000000000000000000000", now);

    const body = await json(await get(app, "/api/v1/projects", cookie));
    const mine = body.items.find((p: { id: string }) => p.id === projectId);
    expect(mine.activeDeployment).toBeNull();
  });
});
