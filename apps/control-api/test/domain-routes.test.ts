/**
 * Domain Routes API — HTTP round-trip tests
 * docs/phase-05-domains.md M3
 *
 * ครอบคลุม:
 * - GET /projects/:id/domains → list
 * - POST /projects/:id/domains → create with validation
 * - PATCH /projects/:id/domains/:domainId → update
 * - DELETE /projects/:id/domains/:domainId → delete
 * - POST /projects/:id/domains/:domainId/check → DNS check (mock dns ไม่ resolve)
 * - Hostname validation rejection: scheme, path, wildcard, IP, reserved TLD
 * - Duplicate hostname → 409
 * - Domain ของ project อื่น → 404
 * - Project ไม่มีอยู่ → 404
 * - Unauthenticated → 401
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
     VALUES (?, 'domain-test', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(projectId, now, now);

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
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
  const csrf = cookies.zx_csrf ?? "";

  return { db, app, projectId, cookie, csrf };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createDomain(
  app: ReturnType<typeof buildApp>,
  projectId: string,
  cookie: string,
  csrf: string,
  body: Record<string, unknown>,
) {
  return app.handle(
    new Request(`http://localhost/api/v1/projects/${projectId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
      body: JSON.stringify(body),
    }),
  );
}

// ---------------------------------------------------------------------------
// GET /projects/:id/domains
// ---------------------------------------------------------------------------

describe("GET /projects/:id/domains", () => {
  test("list ว่างเมื่อยังไม่มี domain", async () => {
    const { app, projectId, cookie } = await setup();
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/domains`, { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.domains).toEqual([]);
  });

  test("คืน domain ที่สร้างแล้ว", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    await createDomain(app, projectId, cookie, csrf, {
      hostname: "example.com",
      internalPort: 3000,
    });
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/domains`, { headers: { cookie } }),
    );
    const body = await json(res);
    expect(body.domains).toHaveLength(1);
    expect(body.domains[0].hostname).toBe("example.com");
  });

  test("project ไม่มีอยู่ → 404", async () => {
    const { app, cookie } = await setup();
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${ulid()}/domains`, { headers: { cookie } }),
    );
    expect(res.status).toBe(404);
  });

  test("unauthenticated → 401", async () => {
    const { app, projectId } = await setup();
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/domains`),
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /projects/:id/domains
// ---------------------------------------------------------------------------

describe("POST /projects/:id/domains — สร้าง domain สำเร็จ", () => {
  test("สร้าง domain ด้วย defaults", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await createDomain(app, projectId, cookie, csrf, {
      hostname: "example.com",
      internalPort: 3000,
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.hostname).toBe("example.com");
    expect(body.internalPort).toBe(3000);
    expect(body.httpsEnabled).toBe(true);
    expect(body.redirectHttp).toBe(true);
    expect(body.redirectMode).toBe("none");
    expect(body.dnsStatus).toBe("pending");
    expect(body.enabled).toBe(true);
    expect(body.id).toBeTruthy();
  });

  test("normalize hostname uppercase → lowercase", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await createDomain(app, projectId, cookie, csrf, {
      hostname: "EXAMPLE.COM",
      internalPort: 3000,
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.hostname).toBe("example.com");
  });

  test("custom options (httpsEnabled=false, redirectMode=www_to_root)", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await createDomain(app, projectId, cookie, csrf, {
      hostname: "sub.example.com",
      internalPort: 8080,
      httpsEnabled: false,
      redirectHttp: false,
      redirectMode: "www_to_root",
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.httpsEnabled).toBe(false);
    expect(body.redirectHttp).toBe(false);
    expect(body.redirectMode).toBe("www_to_root");
  });
});

describe("POST /projects/:id/domains — hostname validation rejection", () => {
  test("https:// scheme → 422", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await createDomain(app, projectId, cookie, csrf, {
      hostname: "https://example.com",
      internalPort: 3000,
    });
    expect(res.status).toBe(422);
  });

  test("path → 422", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await createDomain(app, projectId, cookie, csrf, {
      hostname: "example.com/path",
      internalPort: 3000,
    });
    expect(res.status).toBe(422);
  });

  test("wildcard → 422", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await createDomain(app, projectId, cookie, csrf, {
      hostname: "*.example.com",
      internalPort: 3000,
    });
    expect(res.status).toBe(422);
  });

  test("IPv4 → 422", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await createDomain(app, projectId, cookie, csrf, {
      hostname: "192.168.1.1",
      internalPort: 3000,
    });
    expect(res.status).toBe(422);
  });

  test("reserved TLD (.local) → 422", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await createDomain(app, projectId, cookie, csrf, {
      hostname: "myapp.local",
      internalPort: 3000,
    });
    expect(res.status).toBe(422);
  });

  test("duplicate hostname → 409", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    await createDomain(app, projectId, cookie, csrf, {
      hostname: "example.com",
      internalPort: 3000,
    });
    const res = await createDomain(app, projectId, cookie, csrf, {
      hostname: "example.com",
      internalPort: 4000,
    });
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// PATCH /projects/:id/domains/:domainId
// ---------------------------------------------------------------------------

describe("PATCH /projects/:id/domains/:domainId", () => {
  test("update internalPort", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const created = await json(
      await createDomain(app, projectId, cookie, csrf, {
        hostname: "example.com",
        internalPort: 3000,
      }),
    );

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/domains/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify({ internalPort: 4000 }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.internalPort).toBe(4000);
  });

  test("disable domain (enabled=false)", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const created = await json(
      await createDomain(app, projectId, cookie, csrf, {
        hostname: "example.com",
        internalPort: 3000,
      }),
    );

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/domains/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.enabled).toBe(false);
  });

  test("domain ของ project อื่น → 404", async () => {
    const { app, db, projectId, cookie, csrf } = await setup();
    const created = await json(
      await createDomain(app, projectId, cookie, csrf, {
        hostname: "example.com",
        internalPort: 3000,
      }),
    );

    // สร้าง project อื่น
    const otherId = ulid();
    const now = Date.now();
    db.query(
      `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
       VALUES (?, 'other', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
    ).run(otherId, now, now);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${otherId}/domains/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /projects/:id/domains/:domainId
// ---------------------------------------------------------------------------

describe("DELETE /projects/:id/domains/:domainId", () => {
  test("ลบสำเร็จ → 204, list ว่าง", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const created = await json(
      await createDomain(app, projectId, cookie, csrf, {
        hostname: "example.com",
        internalPort: 3000,
      }),
    );

    const delRes = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/domains/${created.id}`, {
        method: "DELETE",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(delRes.status).toBe(204);

    const listRes = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/domains`, {
        headers: { cookie },
      }),
    );
    const body = await json(listRes);
    expect(body.domains).toHaveLength(0);
  });

  test("domain ไม่มีอยู่ → 404", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/domains/${ulid()}`, {
        method: "DELETE",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /projects/:id/domains/:domainId/check
// ---------------------------------------------------------------------------

describe("POST /projects/:id/domains/:domainId/check", () => {
  test("DNS check → อัปเดต dns_status (unknown ถ้า resolve ไม่ได้)", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const created = await json(
      await createDomain(app, projectId, cookie, csrf, {
        // hostname ที่แน่นอนว่า resolve ไม่ได้ในสภาพแวดล้อม test
        hostname: "zixploy-test-nonexistent-12345.example.com",
        internalPort: 3000,
      }),
    );
    // สถานะเริ่มต้น pending
    expect(created.dnsStatus).toBe("pending");

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/domains/${created.id}/check`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);

    // ต้องมีทั้ง domain (updated) และ check info
    expect(body.domain).toBeTruthy();
    expect(body.check.resolvedAddresses).toBeInstanceOf(Array);
    expect(body.check.configuredIps).toBeInstanceOf(Array);

    // status ต้องเปลี่ยนจาก pending → unknown หรือ mismatch (ไม่ใช่ pending อีก)
    expect(body.domain.dnsStatus).not.toBe("pending");
    expect(body.domain.dnsCheckedAt).not.toBeNull();
  });

  test("domain ของ project อื่น → 404", async () => {
    const { app, db, projectId, cookie, csrf } = await setup();
    const created = await json(
      await createDomain(app, projectId, cookie, csrf, {
        hostname: "zixploy-check.example.com",
        internalPort: 3000,
      }),
    );

    const otherId = ulid();
    const now = Date.now();
    db.query(
      `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
       VALUES (?, 'other2', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
    ).run(otherId, now, now);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${otherId}/domains/${created.id}/check`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// path prefix + componentId (0.1.24)
// ---------------------------------------------------------------------------

function insertComponent(
  db: ReturnType<typeof openDatabase>,
  projectId: string,
  name: string,
  opts: { isWeb: boolean },
): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO project_components
      (id, project_id, name, role, source_kind, image_ref, is_web, web_port, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'image', 'ghcr.io/acme/x:1', ?, ?, ?, ?)`,
  ).run(id, projectId, name, opts.isWeb ? "web" : "worker", opts.isWeb ? 1 : 0, 3001, now, now);
  return id;
}

describe("POST /projects/:id/domains — path prefix + componentId", () => {
  test("host เดียวกันมีแถวทั้ง host และแถว path ได้ — path ถูก normalize", async () => {
    const { app, db, projectId, cookie, csrf } = await setup();
    const apiId = insertComponent(db, projectId, "api", { isWeb: true });
    const whole = await createDomain(app, projectId, cookie, csrf, {
      hostname: "app.example.com",
      internalPort: 3000,
    });
    expect(whole.status).toBe(201);
    const path = await createDomain(app, projectId, cookie, csrf, {
      hostname: "app.example.com",
      pathPrefix: "/api",
      componentId: apiId,
      internalPort: 3001,
    });
    expect(path.status).toBe(201);
    const body = await json(path);
    expect(body.pathPrefix).toBe("/api/");
    expect(body.componentId).toBe(apiId);
    expect((await json(whole)).pathPrefix).toBeNull();
  });

  test("host + path ซ้ำ → 409 DOMAIN_DUPLICATE", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const body = { hostname: "app.example.com", pathPrefix: "/api/", internalPort: 3001 };
    expect((await createDomain(app, projectId, cookie, csrf, body)).status).toBe(201);
    const dup = await createDomain(app, projectId, cookie, csrf, { ...body, pathPrefix: "/api" });
    expect(dup.status).toBe(409);
  });

  test("path prefix ผิดรูปแบบ → 422 DOMAIN_INVALID", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await createDomain(app, projectId, cookie, csrf, {
      hostname: "app.example.com",
      pathPrefix: "/api`) || Host(`evil.com",
      internalPort: 3001,
    });
    expect(res.status).toBe(422);
  });

  test("path prefix + redirect www → 422 DOMAIN_INVALID", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await createDomain(app, projectId, cookie, csrf, {
      hostname: "app.example.com",
      pathPrefix: "/api/",
      redirectMode: "www_to_root",
      internalPort: 3001,
    });
    expect(res.status).toBe(422);
  });

  test("componentId ที่ไม่ใช่ web หรือเป็นของ project อื่น → 400", async () => {
    const { app, db, projectId, cookie, csrf } = await setup();
    const workerId = insertComponent(db, projectId, "worker", { isWeb: false });
    const notWeb = await createDomain(app, projectId, cookie, csrf, {
      hostname: "a.example.com",
      componentId: workerId,
      internalPort: 3001,
    });
    expect(notWeb.status).toBe(400);
    const foreign = await createDomain(app, projectId, cookie, csrf, {
      hostname: "b.example.com",
      componentId: ulid(),
      internalPort: 3001,
    });
    expect(foreign.status).toBe(400);
  });

  test("PATCH ย้าย component ได้ และ null = กลับไป web ตัวแรก", async () => {
    const { app, db, projectId, cookie, csrf } = await setup();
    const apiId = insertComponent(db, projectId, "api", { isWeb: true });
    const created = await json(
      await createDomain(app, projectId, cookie, csrf, {
        hostname: "api.example.com",
        internalPort: 3001,
      }),
    );
    const patch = (componentId: string | null) =>
      app.handle(
        new Request(`http://localhost/api/v1/projects/${projectId}/domains/${created.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
          body: JSON.stringify({ componentId }),
        }),
      );
    expect((await json(await patch(apiId))).componentId).toBe(apiId);
    expect((await json(await patch(null))).componentId).toBeNull();
  });

  test("ลบ component → domain ที่ผูกไว้ถูกปลดเป็น null (ไม่ติด FK)", async () => {
    const { app, db, projectId, cookie, csrf } = await setup();
    const apiId = insertComponent(db, projectId, "api", { isWeb: true });
    const created = await json(
      await createDomain(app, projectId, cookie, csrf, {
        hostname: "api.example.com",
        componentId: apiId,
        internalPort: 3001,
      }),
    );
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/components/${apiId}`, {
        method: "DELETE",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(res.status).toBeLessThan(300);
    const row = db
      .query<{ component_id: string | null }, [string]>(
        "SELECT component_id FROM project_domains WHERE id = ?",
      )
      .get(created.id);
    expect(row?.component_id).toBeNull();
  });
});
