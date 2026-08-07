/**
 * ลบประวัติ deployment — Phase 11
 *
 * เน้น guard ที่ถ้าพลาดแล้วระบบพัง:
 * - ห้ามลบ deployment ที่ container ยังให้บริการอยู่ (restart/stop/rollback อ้างแถวนี้)
 * - ห้ามลบตัวที่ยังทำงานอยู่ (worker เขียน status กลับไม่ได้)
 * - deploy_jobs ที่อ้างถึงต้องถูกลบก่อน ไม่งั้น FK block
 * - build_logs ต้องหายตาม (ON DELETE CASCADE)
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
     VALUES (?, 'proj', 'running', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
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

type Ctx = Awaited<ReturnType<typeof setup>>;

function addDeployment(
  ctx: Ctx,
  opts: { status: string; containerId?: string | null; at: number; finishedAt?: number },
): string {
  const id = ulid();
  ctx.db
    .query(
      `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, container_id,
                                queued_at, finished_at, created_at, updated_at)
       VALUES (?, ?, ?, 'manual', 'abc1234', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ctx.projectId,
      opts.status,
      opts.containerId ?? null,
      opts.at,
      opts.finishedAt ?? opts.at,
      opts.at,
      opts.at,
    );
  return id;
}

function del(ctx: Ctx, deploymentId: string) {
  return ctx.app.handle(
    new Request(`http://localhost/api/v1/projects/${ctx.projectId}/deployments/${deploymentId}`, {
      method: "DELETE",
      headers: { cookie: ctx.cookie, "x-csrf-token": ctx.csrf },
    }),
  );
}

function prune(ctx: Ctx, keep?: number) {
  return ctx.app.handle(
    new Request(`http://localhost/api/v1/projects/${ctx.projectId}/deployments/prune`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ctx.cookie, "x-csrf-token": ctx.csrf },
      body: JSON.stringify(keep === undefined ? {} : { keep }),
    }),
  );
}

function countDeployments(ctx: Ctx): number {
  return ctx.db.query<{ c: number }, []>("SELECT COUNT(*) c FROM deployments").get()?.c ?? 0;
}

// ---------------------------------------------------------------------------

describe("DELETE /projects/:id/deployments/:deploymentId", () => {
  test("ลบ deployment ที่จบแล้วและไม่ใช่ตัว active ได้", async () => {
    const ctx = await setup();
    addDeployment(ctx, { status: "succeeded", containerId: "cur", at: ctx.now });
    const old = addDeployment(ctx, { status: "failed", at: ctx.now - 10_000 });

    const res = await del(ctx, old);
    expect(res.status).toBe(200);
    expect((await json(res)).deleted).toBe(1);
    expect(countDeployments(ctx)).toBe(1);
  });

  test("ห้ามลบตัวที่ container ยังให้บริการอยู่ → 409", async () => {
    const ctx = await setup();
    const active = addDeployment(ctx, { status: "succeeded", containerId: "live", at: ctx.now });

    const res = await del(ctx, active);
    expect(res.status).toBe(409);
    expect((await json(res)).error.message).toContain("ให้บริการอยู่");
    expect(countDeployments(ctx)).toBe(1);
  });

  test("ห้ามลบตัวที่ยังทำงานอยู่ (building) → 409", async () => {
    const ctx = await setup();
    const running = addDeployment(ctx, { status: "building", at: ctx.now });

    const res = await del(ctx, running);
    expect(res.status).toBe(409);
    expect((await json(res)).error.message).toContain("กำลังทำงาน");
  });

  test("succeeded ที่ไม่ใช่ตัวล่าสุดลบได้ (ไม่ใช่ active แล้ว)", async () => {
    const ctx = await setup();
    const older = addDeployment(ctx, {
      status: "succeeded",
      containerId: "old",
      at: ctx.now - 20_000,
      finishedAt: ctx.now - 20_000,
    });
    addDeployment(ctx, {
      status: "succeeded",
      containerId: "new",
      at: ctx.now,
      finishedAt: ctx.now,
    });

    expect((await del(ctx, older)).status).toBe(200);
  });

  test("build_logs หายตามผ่าน CASCADE", async () => {
    const ctx = await setup();
    addDeployment(ctx, { status: "succeeded", containerId: "cur", at: ctx.now });
    const target = addDeployment(ctx, { status: "failed", at: ctx.now - 5_000 });

    ctx.db
      .query(
        "INSERT INTO build_logs (id, deployment_id, seq, stream, line, created_at) VALUES (?, ?, 1, 'stdout', 'x', ?)",
      )
      .run(ulid(), target, ctx.now);

    await del(ctx, target);
    const left = ctx.db.query<{ c: number }, []>("SELECT COUNT(*) c FROM build_logs").get();
    expect(left?.c).toBe(0);
  });

  test("deploy_jobs ที่อ้างถึงถูกลบก่อน — ไม่ติด FK constraint", async () => {
    const ctx = await setup();
    addDeployment(ctx, { status: "succeeded", containerId: "cur", at: ctx.now });
    const target = addDeployment(ctx, { status: "failed", at: ctx.now - 5_000 });

    ctx.db
      .query(
        `INSERT INTO deploy_jobs (id, project_id, deployment_id, type, status, payload, created_at, updated_at)
         VALUES (?, ?, ?, 'deploy', 'done', '{}', ?, ?)`,
      )
      .run(ulid(), ctx.projectId, target, ctx.now, ctx.now);

    const res = await del(ctx, target);
    expect(res.status).toBe(200);
    expect(ctx.db.query<{ c: number }, []>("SELECT COUNT(*) c FROM deploy_jobs").get()?.c).toBe(0);
  });

  test("deployment ของ project อื่น → 404", async () => {
    const ctx = await setup();
    const otherProject = ulid();
    ctx.db
      .query(
        `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
         VALUES (?, 'other', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
      )
      .run(otherProject, ctx.now, ctx.now);
    const foreign = ulid();
    ctx.db
      .query(
        `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
         VALUES (?, ?, 'failed', 'manual', 'abc1234', ?, ?, ?)`,
      )
      .run(foreign, otherProject, ctx.now, ctx.now, ctx.now);

    expect((await del(ctx, foreign)).status).toBe(404);
  });

  test("id ที่ไม่มีจริง → 404", async () => {
    const ctx = await setup();
    expect((await del(ctx, ulid())).status).toBe(404);
  });

  test("ไม่ login → 401", async () => {
    const ctx = await setup();
    const id = addDeployment(ctx, { status: "failed", at: ctx.now });
    const res = await ctx.app.handle(
      new Request(`http://localhost/api/v1/projects/${ctx.projectId}/deployments/${id}`, {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /projects/:id/deployments/prune", () => {
  test("ลบทั้งหมดยกเว้นตัวที่ลบไม่ได้", async () => {
    const ctx = await setup();
    addDeployment(ctx, { status: "succeeded", containerId: "live", at: ctx.now });
    addDeployment(ctx, { status: "failed", at: ctx.now - 1_000 });
    addDeployment(ctx, { status: "failed", at: ctx.now - 2_000 });
    addDeployment(ctx, { status: "cancelled", at: ctx.now - 3_000 });

    const body = await json(await prune(ctx));
    expect(body.deleted).toBe(3);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].reason).toContain("ให้บริการอยู่");
    expect(countDeployments(ctx)).toBe(1);
  });

  test("keep=2 เก็บ 2 รายการล่าสุดไว้", async () => {
    const ctx = await setup();
    for (let i = 0; i < 5; i++) {
      addDeployment(ctx, { status: "failed", at: ctx.now - i * 1_000 });
    }

    const body = await json(await prune(ctx, 2));
    expect(body.deleted).toBe(3);
    expect(countDeployments(ctx)).toBe(2);
  });

  test("keep ไม่นับตัวที่ลบไม่ได้เป็น skipped (มันอยู่ในโควตา keep อยู่แล้ว)", async () => {
    const ctx = await setup();
    addDeployment(ctx, { status: "succeeded", containerId: "live", at: ctx.now });
    addDeployment(ctx, { status: "failed", at: ctx.now - 1_000 });

    const body = await json(await prune(ctx, 1));
    expect(body.deleted).toBe(1);
    expect(body.skipped).toHaveLength(0);
  });

  test("ตัวที่กำลังทำงานอยู่ถูกข้ามพร้อมเหตุผล", async () => {
    const ctx = await setup();
    addDeployment(ctx, { status: "building", at: ctx.now });
    addDeployment(ctx, { status: "failed", at: ctx.now - 1_000 });

    const body = await json(await prune(ctx));
    expect(body.deleted).toBe(1);
    expect(body.skipped[0].reason).toContain("กำลังทำงาน");
  });

  test("ไม่มีอะไรให้ลบ → deleted 0 ไม่ error", async () => {
    const ctx = await setup();
    const body = await json(await prune(ctx));
    expect(body.deleted).toBe(0);
  });

  test("keep เกิน 100 → 400 (กันค่าเพี้ยน)", async () => {
    const ctx = await setup();
    expect((await prune(ctx, 500)).status).toBe(400);
  });
});

describe("GET /projects/:id/deployments — total", () => {
  test("คืน total ของทั้ง project ไม่ใช่แค่หน้าปัจจุบัน", async () => {
    const ctx = await setup();
    for (let i = 0; i < 25; i++) {
      addDeployment(ctx, { status: "failed", at: ctx.now - i * 1_000 });
    }

    const body = await json(
      await ctx.app.handle(
        new Request(`http://localhost/api/v1/projects/${ctx.projectId}/deployments?limit=10`, {
          headers: { cookie: ctx.cookie },
        }),
      ),
    );
    expect(body.items).toHaveLength(10);
    expect(body.total).toBe(25);
    expect(body.nextCursor).toBeDefined();
  });

  test("หน้าสุดท้ายไม่มี nextCursor", async () => {
    const ctx = await setup();
    addDeployment(ctx, { status: "failed", at: ctx.now });

    const body = await json(
      await ctx.app.handle(
        new Request(`http://localhost/api/v1/projects/${ctx.projectId}/deployments?limit=10`, {
          headers: { cookie: ctx.cookie },
        }),
      ),
    );
    expect(body.total).toBe(1);
    expect(body.nextCursor).toBeUndefined();
  });
});
