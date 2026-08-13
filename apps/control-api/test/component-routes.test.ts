/**
 * Project component routes — HTTP round-trip tests (Phase 18, multi-container)
 *
 * ครอบ: create/update/delete + validation (name DNS-label, image ref, is_web/webPort,
 * managed_ref), dependency DAG (ref-not-found / self / cycle), promote → mode='compose'
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
     VALUES (?, 'app', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
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
  const csrf = cookies.zx_csrf ?? "";

  return { db, app, cookie, csrf, projectId };
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

const buildComp = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  sourceKind: "build",
  ...extra,
});

// ---------------------------------------------------------------------------

describe("POST /projects/:id/components — create", () => {
  test("build component → 201, position เริ่มที่ 0", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    const res = await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, {
      name: "web",
      sourceKind: "build",
      targetStage: "runtime",
      isWeb: true,
      webPort: 3000,
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.name).toBe("web");
    expect(body.sourceKind).toBe("build");
    expect(body.dockerfilePath).toBe("Dockerfile");
    expect(body.isWeb).toBe(true);
    expect(body.position).toBe(0);
  });

  test("image component ที่มี tag → 201", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    const res = await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, {
      name: "cache",
      sourceKind: "image",
      imageRef: "redis:7-alpine",
    });
    expect(res.status).toBe(201);
    expect((await json(res)).imageRef).toBe("redis:7-alpine");
  });

  test("image ที่ไม่มี tag → 422", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    const res = await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, {
      name: "cache",
      sourceKind: "image",
      imageRef: "redis",
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe("COMPONENT_INVALID");
  });

  test("image tag 'latest' → 422 (ไม่ deterministic)", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    const res = await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, {
      name: "cache",
      sourceKind: "image",
      imageRef: "redis:latest",
    });
    expect(res.status).toBe(422);
  });

  test("image ที่มี registry + digest → 201", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    const digest = `ghcr.io/foo/bar@sha256:${"a".repeat(64)}`;
    const res = await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, {
      name: "svc",
      sourceKind: "image",
      imageRef: digest,
    });
    expect(res.status).toBe(201);
  });

  test("healthCmd → 201 และคืนค่ากลับใน DTO (Phase F)", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    const res = await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, {
      name: "db",
      sourceKind: "image",
      imageRef: "postgres:16-alpine",
      healthCmd: "pg_isready -U app",
    });
    expect(res.status).toBe(201);
    expect((await json(res)).healthCmd).toBe("pg_isready -U app");
  });

  test("healthCmd ที่มี control character (newline) → 422", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    const res = await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, {
      name: "db",
      sourceKind: "image",
      imageRef: "postgres:16-alpine",
      healthCmd: "pg_isready\nrm -rf /",
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe("COMPONENT_INVALID");
  });

  test("managed_ref ที่ service ไม่มีจริง → 422", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    const res = await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, {
      name: "db",
      sourceKind: "managed_ref",
      managedServiceId: ulid(),
    });
    expect(res.status).toBe(422);
  });

  test("managed_ref ที่ service มีจริง → 201", async () => {
    const { app, db, cookie, csrf, projectId } = await setup();
    const svcId = ulid();
    const now = Date.now();
    db.query(
      `INSERT INTO services (id, name, type, version, image, status, volume_name, username, database_name, internal_port, created_at, updated_at)
       VALUES (?, 'pg', 'postgres', '17', 'postgres:17', 'running', 'v', 'app', 'app', 5432, ?, ?)`,
    ).run(svcId, now, now);
    const res = await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, {
      name: "db",
      sourceKind: "managed_ref",
      managedServiceId: svcId,
    });
    expect(res.status).toBe(201);
    expect((await json(res)).managedServiceId).toBe(svcId);
  });

  test("ชื่อไม่ใช่ DNS label → 422 (จาก validator)", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    for (const bad of ["Web", "-web", "web_1", "a b"]) {
      const res = await post(
        app,
        `/api/v1/projects/${projectId}/components`,
        cookie,
        csrf,
        buildComp(bad),
      );
      expect(res.status).toBe(422);
      expect((await json(res)).error.code).toBe("COMPONENT_INVALID");
    }
  });

  test("ชื่อยาวเกิน 31 ตัว → 400 (schema ปฏิเสธก่อนถึง handler)", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    const res = await post(
      app,
      `/api/v1/projects/${projectId}/components`,
      cookie,
      csrf,
      buildComp("a".repeat(32)),
    );
    expect(res.status).toBe(400);
  });

  test("ชื่อซ้ำในโปรเจกต์ → 409", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, buildComp("web"));
    const res = await post(
      app,
      `/api/v1/projects/${projectId}/components`,
      cookie,
      csrf,
      buildComp("web"),
    );
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("COMPONENT_DUPLICATE_NAME");
  });

  test("is_web แต่ไม่ระบุ webPort → 422", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    const res = await post(
      app,
      `/api/v1/projects/${projectId}/components`,
      cookie,
      csrf,
      buildComp("web", { isWeb: true }),
    );
    expect(res.status).toBe(422);
  });

  test("ไม่ login → 401", async () => {
    const { app, projectId } = await setup();
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/components`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildComp("web")),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("project ที่ไม่มีจริง → 404", async () => {
    const { app, cookie, csrf } = await setup();
    const res = await post(
      app,
      `/api/v1/projects/${ulid()}/components`,
      cookie,
      csrf,
      buildComp("web"),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /projects/:id/components — list", () => {
  test("เรียงตาม position", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, buildComp("web"));
    await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, buildComp("worker"));
    const body = await json(await get(app, `/api/v1/projects/${projectId}/components`, cookie));
    expect(body.items.map((c: { name: string }) => c.name)).toEqual(["web", "worker"]);
    expect(body.items[0].position).toBe(0);
    expect(body.items[1].position).toBe(1);
  });
});

describe("dependency DAG", () => {
  test("depends_on อ้างชื่อที่มีจริง → เก็บได้", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, {
      name: "cache",
      sourceKind: "image",
      imageRef: "redis:7",
    });
    const res = await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, {
      name: "web",
      sourceKind: "build",
      isWeb: true,
      webPort: 3000,
      dependsOn: [{ name: "cache", condition: "healthy" }],
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.dependsOn).toHaveLength(1);
    expect(body.dependsOn[0].name).toBe("cache");
    expect(body.dependsOn[0].condition).toBe("healthy");
  });

  test("depends_on อ้างชื่อที่ไม่มี → 422 COMPONENT_DEP_INVALID", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    const res = await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, {
      name: "web",
      sourceKind: "build",
      dependsOn: [{ name: "ghost" }],
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe("COMPONENT_DEP_INVALID");
  });

  test("cycle → 422", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    // a, b แล้วให้ b→a, จากนั้นพยายามตั้ง a→b (เกิด cycle)
    const a = await json(
      await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, buildComp("a")),
    );
    await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, {
      name: "b",
      sourceKind: "build",
      dependsOn: [{ name: "a" }],
    });
    const res = await patch(app, `/api/v1/projects/${projectId}/components/${a.id}`, cookie, csrf, {
      dependsOn: [{ name: "b" }],
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe("COMPONENT_DEP_INVALID");
  });

  test("self-dependency → 422", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    const a = await json(
      await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, buildComp("a")),
    );
    const res = await patch(app, `/api/v1/projects/${projectId}/components/${a.id}`, cookie, csrf, {
      dependsOn: [{ name: "a" }],
    });
    expect(res.status).toBe(422);
  });
});

describe("PATCH + DELETE", () => {
  test("แก้ isWeb/webPort → 200", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    const c = await json(
      await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, buildComp("web")),
    );
    const res = await patch(app, `/api/v1/projects/${projectId}/components/${c.id}`, cookie, csrf, {
      isWeb: true,
      webPort: 8080,
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.isWeb).toBe(true);
    expect(body.webPort).toBe(8080);
  });

  test("แก้ชื่อชนกับตัวอื่น → 409", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, buildComp("web"));
    const c2 = await json(
      await post(
        app,
        `/api/v1/projects/${projectId}/components`,
        cookie,
        csrf,
        buildComp("worker"),
      ),
    );
    const res = await patch(
      app,
      `/api/v1/projects/${projectId}/components/${c2.id}`,
      cookie,
      csrf,
      { name: "web" },
    );
    expect(res.status).toBe(409);
  });

  test("ลบ → 204 และ dependency ที่ชี้มาถูกลบตาม (cascade)", async () => {
    const { app, db, cookie, csrf, projectId } = await setup();
    const cache = await json(
      await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, {
        name: "cache",
        sourceKind: "image",
        imageRef: "redis:7",
      }),
    );
    await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, {
      name: "web",
      sourceKind: "build",
      dependsOn: [{ name: "cache" }],
    });
    const res = await del(
      app,
      `/api/v1/projects/${projectId}/components/${cache.id}`,
      cookie,
      csrf,
    );
    expect(res.status).toBe(204);
    const depCount = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM component_deps").get();
    expect(depCount?.n).toBe(0);
  });
});

describe("POST /projects/:id/compose/promote", () => {
  test("ไม่มี component → 422", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    const res = await post(app, `/api/v1/projects/${projectId}/compose/promote`, cookie, csrf);
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe("COMPOSE_PROMOTE_INVALID");
  });

  test("มี component แต่ไม่มี web → 422", async () => {
    const { app, cookie, csrf, projectId } = await setup();
    await post(app, `/api/v1/projects/${projectId}/components`, cookie, csrf, buildComp("worker"));
    const res = await post(app, `/api/v1/projects/${projectId}/compose/promote`, cookie, csrf);
    expect(res.status).toBe(422);
  });

  test("มี web component → 200, projects.mode = 'compose'", async () => {
    const { app, db, cookie, csrf, projectId } = await setup();
    await post(
      app,
      `/api/v1/projects/${projectId}/components`,
      cookie,
      csrf,
      buildComp("web", { isWeb: true, webPort: 3000 }),
    );
    const res = await post(app, `/api/v1/projects/${projectId}/compose/promote`, cookie, csrf);
    expect(res.status).toBe(200);
    expect((await json(res)).mode).toBe("compose");
    const mode = db
      .query<{ mode: string }, [string]>("SELECT mode FROM projects WHERE id = ?")
      .get(projectId);
    expect(mode?.mode).toBe("compose");
  });
});
