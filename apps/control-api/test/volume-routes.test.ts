/**
 * Volume Routes API — HTTP round-trip tests (docs/phase-07-volumes.md M3)
 *
 * ครอบคลุม:
 * - GET /projects/:id/volumes → empty list
 * - POST /projects/:id/volumes → create volume, validate path/driver
 * - PATCH → update display name / mount path
 * - POST /detach → lifecycle เปลี่ยนเป็น detached
 * - DELETE → ปฏิเสธถ้า active; สำเร็จถ้า detached → deletion_pending
 * - POST /inspect → คืนสถานะปัจจุบัน
 * - Unauthenticated → 401
 * - Project/Volume ไม่มีอยู่ → 404
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { json } from "./helpers";

// ---------------------------------------------------------------------------
// Setup
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
    `INSERT INTO projects
       (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'vol-test', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(projectId, now, now);

  const app = buildApp(db);

  // Login
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
    if (eq > 0) cookies[pair!.slice(0, eq)] = pair!.slice(eq + 1);
  }
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  const csrf = cookies.zx_csrf ?? "";

  function request(path: string, init: RequestInit = {}) {
    return app.handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: {
          cookie: cookieHeader,
          "x-csrf-token": csrf,
          ...(init.headers as Record<string, string>),
        },
      }),
    );
  }

  return { db, app, projectId, request };
}

// ---------------------------------------------------------------------------
// GET volumes
// ---------------------------------------------------------------------------

describe("GET /projects/:id/volumes", () => {
  test("empty list สำหรับ project ใหม่", async () => {
    const { projectId, request } = await setup();
    const res = await request(`/api/v1/projects/${projectId}/volumes`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.volumes).toEqual([]);
  });

  test("project ไม่มีอยู่ → 404", async () => {
    const { request } = await setup();
    const res = await request(`/api/v1/projects/${ulid()}/volumes`);
    expect(res.status).toBe(404);
  });

  test("ไม่ล็อกอิน → 401", async () => {
    const { app, projectId } = await setup();
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/volumes`),
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST (create) volumes
// ---------------------------------------------------------------------------

describe("POST /projects/:id/volumes", () => {
  test("สร้าง volume สำเร็จ", async () => {
    const { projectId, request } = await setup();
    const res = await request(`/api/v1/projects/${projectId}/volumes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "my-data", mountPath: "/app/data" }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.volume.displayName).toBe("my-data");
    expect(body.volume.mountPath).toBe("/app/data");
    expect(body.volume.lifecycle).toBe("active");
    expect(body.volume.driver).toBe("local");
    expect(body.volume.readOnly).toBe(false);
    expect(body.volume.dockerName).toMatch(/^zxvol-/);
  });

  test("ชี้ specific access_mode และ readOnly", async () => {
    const { projectId, request } = await setup();
    const res = await request(`/api/v1/projects/${projectId}/volumes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "readonly-assets",
        mountPath: "/app/assets",
        accessMode: "single-writer",
        readOnly: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.volume.accessMode).toBe("single-writer");
    expect(body.volume.readOnly).toBe(true);
  });

  test("mount path ไม่ absolute → 422", async () => {
    const { projectId, request } = await setup();
    const res = await request(`/api/v1/projects/${projectId}/volumes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "bad", mountPath: "relative/path" }),
    });
    expect(res.status).toBe(422);
  });

  test("mount path /proc → 422 (sensitive)", async () => {
    const { projectId, request } = await setup();
    const res = await request(`/api/v1/projects/${projectId}/volumes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "bad", mountPath: "/proc" }),
    });
    expect(res.status).toBe(422);
  });

  test("driver ไม่ได้รับอนุญาต → 422", async () => {
    const { projectId, request } = await setup();
    const res = await request(`/api/v1/projects/${projectId}/volumes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "nfs-vol", mountPath: "/data", driver: "nfs" }),
    });
    expect(res.status).toBe(422);
  });

  test("mount path ซ้ำใน project เดียวกัน → 409", async () => {
    const { projectId, request } = await setup();
    // สร้าง volume แรก
    await request(`/api/v1/projects/${projectId}/volumes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "vol1", mountPath: "/app/data" }),
    });
    // volume ที่สองที่ mount path เดียวกัน
    const res = await request(`/api/v1/projects/${projectId}/volumes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "vol2", mountPath: "/app/data" }),
    });
    expect(res.status).toBe(409);
  });

  test("GET หลัง POST เห็น volume ใน list", async () => {
    const { projectId, request } = await setup();
    await request(`/api/v1/projects/${projectId}/volumes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "data-vol", mountPath: "/app/storage" }),
    });
    const listRes = await request(`/api/v1/projects/${projectId}/volumes`);
    const body = await json(listRes);
    expect(body.volumes).toHaveLength(1);
    expect(body.volumes[0].mountPath).toBe("/app/storage");
  });
});

// ---------------------------------------------------------------------------
// PATCH (update) volumes
// ---------------------------------------------------------------------------

describe("PATCH /projects/:id/volumes/:volumeId", () => {
  async function createAndGetId(
    request: Awaited<ReturnType<typeof setup>>["request"],
    projectId: string,
    mountPath = "/app/data",
  ) {
    const res = await request(`/api/v1/projects/${projectId}/volumes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "initial", mountPath }),
    });
    return (await json(res)).volume.id as string;
  }

  test("update displayName สำเร็จ", async () => {
    const { projectId, request } = await setup();
    const id = await createAndGetId(request, projectId);
    const res = await request(`/api/v1/projects/${projectId}/volumes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "updated-name" }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.volume.displayName).toBe("updated-name");
  });

  test("update mountPath สำเร็จ", async () => {
    const { projectId, request } = await setup();
    const id = await createAndGetId(request, projectId);
    const res = await request(`/api/v1/projects/${projectId}/volumes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mountPath: "/app/new-path" }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).volume.mountPath).toBe("/app/new-path");
  });

  test("update mountPath เป็น sensitive path → 422", async () => {
    const { projectId, request } = await setup();
    const id = await createAndGetId(request, projectId);
    const res = await request(`/api/v1/projects/${projectId}/volumes/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mountPath: "/etc/cron.d" }),
    });
    expect(res.status).toBe(422);
  });

  test("volume ไม่มีอยู่ → 404", async () => {
    const { projectId, request } = await setup();
    const res = await request(`/api/v1/projects/${projectId}/volumes/${ulid()}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Detach
// ---------------------------------------------------------------------------

describe("POST /projects/:id/volumes/:volumeId/detach", () => {
  test("lifecycle เปลี่ยนเป็น detached", async () => {
    const { projectId, request } = await setup();
    const createRes = await request(`/api/v1/projects/${projectId}/volumes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "vol", mountPath: "/data" }),
    });
    const volumeId = (await json(createRes)).volume.id as string;

    const res = await request(`/api/v1/projects/${projectId}/volumes/${volumeId}/detach`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.volume.lifecycle).toBe("detached");
  });

  test("detach volume ที่ detached แล้ว → 409", async () => {
    const { projectId, request } = await setup();
    const createRes = await request(`/api/v1/projects/${projectId}/volumes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "vol", mountPath: "/data2" }),
    });
    const volumeId = (await json(createRes)).volume.id as string;

    await request(`/api/v1/projects/${projectId}/volumes/${volumeId}/detach`, { method: "POST" });
    // detach ซ้ำ → 409
    const res = await request(`/api/v1/projects/${projectId}/volumes/${volumeId}/detach`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe("DELETE /projects/:id/volumes/:volumeId", () => {
  test("ลบ active volume → 409 (ต้อง detach ก่อน)", async () => {
    const { projectId, request } = await setup();
    const createRes = await request(`/api/v1/projects/${projectId}/volumes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "vol", mountPath: "/app/storage" }),
    });
    const volumeId = (await json(createRes)).volume.id as string;

    const res = await request(`/api/v1/projects/${projectId}/volumes/${volumeId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(409);
  });

  test("ลบ detached volume → 200, lifecycle = deletion_pending", async () => {
    const { projectId, request } = await setup();
    const createRes = await request(`/api/v1/projects/${projectId}/volumes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "vol", mountPath: "/app/del-test" }),
    });
    const volumeId = (await json(createRes)).volume.id as string;

    // detach ก่อน
    await request(`/api/v1/projects/${projectId}/volumes/${volumeId}/detach`, { method: "POST" });

    const res = await request(`/api/v1/projects/${projectId}/volumes/${volumeId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    // ตรวจ lifecycle ผ่าน inspect
    const inspRes = await request(`/api/v1/projects/${projectId}/volumes/${volumeId}/inspect`, {
      method: "POST",
    });
    expect((await json(inspRes)).volume.lifecycle).toBe("deletion_pending");
  });

  test("volume ไม่มีอยู่ → 404", async () => {
    const { projectId, request } = await setup();
    const res = await request(`/api/v1/projects/${projectId}/volumes/${ulid()}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Inspect
// ---------------------------------------------------------------------------

describe("POST /projects/:id/volumes/:volumeId/inspect", () => {
  test("คืนสถานะปัจจุบันจาก DB", async () => {
    const { projectId, request } = await setup();
    const createRes = await request(`/api/v1/projects/${projectId}/volumes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "vol", mountPath: "/app/inspect-test" }),
    });
    const volumeId = (await json(createRes)).volume.id as string;

    const res = await request(`/api/v1/projects/${projectId}/volumes/${volumeId}/inspect`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.volume.id).toBe(volumeId);
    expect(body.volume.lifecycle).toBe("active");
  });

  test("volume ไม่มีอยู่ → 404", async () => {
    const { projectId, request } = await setup();
    const res = await request(`/api/v1/projects/${projectId}/volumes/${ulid()}/inspect`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});
