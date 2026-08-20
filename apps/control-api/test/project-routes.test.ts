import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { isUlid, ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { json } from "./helpers";

const PASSWORD = "correct horse battery staple";

async function makeApp() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(ulid(), "admin", await hashPassword(PASSWORD), now, now);

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

  /** ยิง request พร้อม session + CSRF ที่ถูกต้อง */
  const call = (path: string, init: RequestInit = {}) =>
    app.handle(
      new Request(`http://localhost/api/v1${path}`, {
        ...init,
        headers: {
          cookie,
          "x-csrf-token": csrf,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      }),
    );

  return { db, app, call, cookie, csrf };
}

describe("authentication guard", () => {
  test("ไม่มี session -> 401 ทุก endpoint ของ projects", async () => {
    const { app } = await makeApp();
    for (const [method, path] of [
      ["GET", "/projects"],
      ["GET", `/projects/${ulid()}`],
    ] as const) {
      const res = await app.handle(new Request(`http://localhost/api/v1${path}`, { method }));
      expect(res.status).toBe(401);
      expect((await json(res)).error.code).toBe("UNAUTHENTICATED");
    }
  });

  test("POST ที่มี session แต่ไม่มี CSRF header -> 403", async () => {
    const { call } = await makeApp();
    const res = await call("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "app" }),
      headers: { "x-csrf-token": "" },
    });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("CSRF_REJECTED");
  });

  test("CSRF token ที่ไม่ตรงกับคุกกี้ -> 403", async () => {
    const { call } = await makeApp();
    const res = await call("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "app" }),
      headers: { "x-csrf-token": "totally-different-token-value" },
    });
    expect(res.status).toBe(403);
  });

  test("GET ไม่ต้องใช้ CSRF (ไม่ใช่ mutation)", async () => {
    const { call } = await makeApp();
    const res = await call("/projects", { headers: { "x-csrf-token": "" } });
    expect(res.status).toBe(200);
  });
});

describe("project CRUD", () => {
  test("สร้าง project ได้ ID เป็น ULID และ status เริ่มต้นเป็น new", async () => {
    const { call } = await makeApp();
    const res = await call("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "my app" }),
    });
    expect(res.status).toBe(201);

    const project = await json(res);
    expect(isUlid(project.id)).toBe(true);
    expect(project.name).toBe("my app");
    expect(project.status).toBe("new");
    expect(project.autoDeploy).toBe(false);
    expect(project.dockerfilePath).toBe("Dockerfile");
    expect(project.archivedAt).toBeNull();
  });

  test("list คืนเฉพาะ project ที่ยังไม่ archive โดยค่าเริ่มต้น", async () => {
    const { call } = await makeApp();
    const created = await json(
      await call("/projects", { method: "POST", body: JSON.stringify({ name: "a" }) }),
    );
    await call("/projects", { method: "POST", body: JSON.stringify({ name: "b" }) });
    await call(`/projects/${created.id}/archive`, { method: "POST" });

    const list = await json(await call("/projects"));
    expect(list.items).toHaveLength(1);
    expect(list.items[0].name).toBe("b");

    const withArchived = await json(await call("/projects?includeArchived=true"));
    expect(withArchived.items).toHaveLength(2);
  });

  test("แก้ไข project ได้และ updatedAt เปลี่ยน", async () => {
    const { call } = await makeApp();
    const created = await json(
      await call("/projects", { method: "POST", body: JSON.stringify({ name: "old name" }) }),
    );

    await Bun.sleep(2);
    const updated = await json(
      await call(`/projects/${created.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "new name", internalPort: 8080, autoDeploy: true }),
      }),
    );

    expect(updated.name).toBe("new name");
    expect(updated.internalPort).toBe(8080);
    expect(updated.autoDeploy).toBe(true);
    expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
  });

  test("archive เป็น soft delete และ idempotent", async () => {
    const { db, call } = await makeApp();
    const created = await json(
      await call("/projects", { method: "POST", body: JSON.stringify({ name: "app" }) }),
    );

    const first = await json(await call(`/projects/${created.id}/archive`, { method: "POST" }));
    expect(first.archivedAt).toBeGreaterThan(0);

    const second = await json(await call(`/projects/${created.id}/archive`, { method: "POST" }));
    expect(second.archivedAt).toBe(first.archivedAt);

    // row ยังอยู่ใน DB (ไม่ใช่ hard delete)
    expect(db.query<{ n: number }, []>("SELECT count(*) as n FROM projects").get()?.n).toBe(1);
  });

  test("แก้ไข project ที่ archive แล้วไม่ได้", async () => {
    const { call } = await makeApp();
    const created = await json(
      await call("/projects", { method: "POST", body: JSON.stringify({ name: "app" }) }),
    );
    await call(`/projects/${created.id}/archive`, { method: "POST" });

    const res = await call(`/projects/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "nope" }),
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("PROJECT_ARCHIVED");
  });

  test("ID ที่ไม่มีอยู่จริงและ ID ที่ไม่ใช่ ULID -> 404 เหมือนกัน", async () => {
    const { call } = await makeApp();
    for (const id of [ulid(), "not-a-ulid", "../../etc/passwd"]) {
      const res = await call(`/projects/${encodeURIComponent(id)}`);
      expect(res.status).toBe(404);
      expect((await json(res)).error.code).toBe("PROJECT_NOT_FOUND");
    }
  });
});

describe("envUpdatedAt", () => {
  /** insert env ตรง ๆ ที่ DB — endpoint จริงต้องผ่านการเข้ารหัส ซึ่งไม่ใช่สิ่งที่เทสต์นี้สนใจ */
  function insertEnvVar(
    db: Database,
    projectId: string,
    key: string,
    updatedAt: number,
    opts: { enabled?: boolean; componentId?: string | null } = {},
  ) {
    db.query(
      `INSERT INTO environment_variables
         (id, project_id, key, value_ciphertext, is_secret, scope, enabled, version, created_at, updated_at, component_id)
       VALUES (?, ?, ?, ?, 0, 'runtime', ?, 1, ?, ?, ?)`,
    ).run(
      ulid(),
      projectId,
      key,
      Buffer.from("ciphertext"),
      opts.enabled === false ? 0 : 1,
      updatedAt,
      updatedAt,
      opts.componentId ?? null,
    );
  }

  test("ไม่มี env เลย -> envUpdatedAt เป็น null", async () => {
    const { call } = await makeApp();
    const created = await json(
      await call("/projects", { method: "POST", body: JSON.stringify({ name: "app" }) }),
    );
    const detail = await json(await call(`/projects/${created.id}`));
    expect(detail.envUpdatedAt).toBeNull();
  });

  test("คืน MAX(updated_at) ของทุก env — รวมตัวที่ disabled และ component-scoped", async () => {
    const { db, call } = await makeApp();
    const created = await json(
      await call("/projects", { method: "POST", body: JSON.stringify({ name: "app" }) }),
    );
    const base = Date.now();

    insertEnvVar(db, created.id, "OLD_KEY", base - 5000);
    // ตัวที่ disabled ก็นับ — การปิด/เปิด env เปลี่ยน config ที่จะถูก inject เหมือนกัน
    insertEnvVar(db, created.id, "DISABLED_KEY", base - 1000, { enabled: false });

    // component-scoped env (Phase 18) นับด้วย — เป็นการแก้ config ของ project เดียวกัน
    const componentId = ulid();
    db.query(
      `INSERT INTO project_components (id, project_id, name, source_kind, image_ref, created_at, updated_at)
       VALUES (?, ?, 'worker', 'image', 'nginx:latest', ?, ?)`,
    ).run(componentId, created.id, base, base);
    insertEnvVar(db, created.id, "COMPONENT_KEY", base + 3000, { componentId });

    const detail = await json(await call(`/projects/${created.id}`));
    expect(detail.envUpdatedAt).toBe(base + 3000);

    // env ของ project อื่นต้องไม่ปนกัน
    const other = await json(
      await call("/projects", { method: "POST", body: JSON.stringify({ name: "other" }) }),
    );
    const otherDetail = await json(await call(`/projects/${other.id}`));
    expect(otherDetail.envUpdatedAt).toBeNull();
  });
});

describe("project validation", () => {
  test("ชื่อว่างหรือยาวเกินถูกปฏิเสธ", async () => {
    const { call } = await makeApp();
    for (const name of ["", "x".repeat(101)]) {
      const res = await call("/projects", { method: "POST", body: JSON.stringify({ name }) });
      expect(res.status).toBe(400);
    }
  });

  test("port นอกช่วงถูกปฏิเสธ", async () => {
    const { call } = await makeApp();
    const created = await json(
      await call("/projects", { method: "POST", body: JSON.stringify({ name: "app" }) }),
    );

    for (const internalPort of [0, 70000, -1]) {
      const res = await call(`/projects/${created.id}`, {
        method: "PATCH",
        body: JSON.stringify({ internalPort }),
      });
      expect(res.status).toBe(400);
    }
  });

  test("dockerfile path ที่พยายาม traverse ออกนอก context ถูกปฏิเสธ", async () => {
    const { call } = await makeApp();
    const created = await json(
      await call("/projects", { method: "POST", body: JSON.stringify({ name: "app" }) }),
    );

    for (const dockerfilePath of [
      "../../../etc/passwd",
      "/etc/passwd",
      "sub/../../outside/Dockerfile",
      "C:\\Windows\\System32\\x",
    ]) {
      const res = await call(`/projects/${created.id}`, {
        method: "PATCH",
        body: JSON.stringify({ dockerfilePath }),
      });
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe("VALIDATION_ERROR");
    }

    // path ปกติยังใช้ได้
    const ok = await call(`/projects/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ dockerfilePath: "docker/Dockerfile.prod" }),
    });
    expect(ok.status).toBe(200);
  });
});
