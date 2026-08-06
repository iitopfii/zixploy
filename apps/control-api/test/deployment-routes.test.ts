import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { createMockRegistry, MOCK_APP_ID } from "./github-mock";
import { json } from "./helpers";

const BRANCHES: import("../src/github/service").Branch[] = [
  { name: "main", protected: true, commitSha: "a".repeat(40) },
  { name: "develop", protected: false, commitSha: "b".repeat(40) },
];

function insertApp(db: ReturnType<typeof openDatabase>, id = MOCK_APP_ID) {
  const now = Date.now();
  db.query(
    `INSERT INTO github_apps
      (id, app_id, slug, name, html_url, owner_login, client_id,
       pem_ciphertext, webhook_secret_ciphertext, client_secret_ciphertext, created_at, updated_at)
     VALUES (?, 123456, 'test-app', 'Test App', 'https://github.com/apps/test-app', 'test-org', 'Iv1.test',
             ?, ?, ?, ?, ?)`,
  ).run(id, new Uint8Array([1]), new Uint8Array([1]), new Uint8Array([1]), now, now);
  return id;
}

function insertInstallation(
  db: ReturnType<typeof openDatabase>,
  installationId: number,
  opts: { status?: string } = {},
) {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO github_installations
      (id, installation_id, account_login, account_type, account_avatar_url, status, github_app_id, created_at, updated_at)
     VALUES (?, ?, 'test-org', 'Organization', 'https://github.com/avatar.png', ?, ?, ?, ?)`,
  ).run(id, installationId, opts.status ?? "active", MOCK_APP_ID, now, now);
  return id;
}

async function login(app: ReturnType<typeof buildApp>) {
  const loginRes = await app.handle(
    new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "correct horse battery staple" }),
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
  return { cookie, csrf: cookies.zx_csrf ?? "" };
}

async function seedUser(db: ReturnType<typeof openDatabase>) {
  const userId = ulid();
  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(userId, "admin", await hashPassword("correct horse battery staple"), now, now);
  return userId;
}

async function setup(mockOpts: Parameters<typeof createMockRegistry>[0] = {}) {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));

  await seedUser(db);
  insertApp(db);

  const registry = createMockRegistry({ branches: BRANCHES, ...mockOpts });
  const app = buildApp(db, { registry });

  const { cookie, csrf } = await login(app);
  return { db, app, registry, cookie, csrf };
}

/** สร้าง project ที่เชื่อมต่อ repo/branch แล้ว (จำลองผลของ POST /projects/:id/source) */
function insertConnectedProject(
  db: ReturnType<typeof openDatabase>,
  opts: { installationDbId: string; repoId?: number; branch?: string; name?: string },
) {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO projects
      (id, name, status, installation_id, repo_id, repo_full_name, branch, auto_deploy,
       dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, ?, 'new', ?, ?, 'test-org/my-app', ?, 1, 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(
    id,
    opts.name ?? "test-project",
    opts.installationDbId,
    opts.repoId ?? 99999,
    opts.branch ?? "main",
    now,
    now,
  );
  return id;
}

function insertBareProject(db: ReturnType<typeof openDatabase>, name = "bare-project") {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, ?, 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(id, name, now, now);
  return id;
}

function insertSucceededDeployment(
  db: ReturnType<typeof openDatabase>,
  projectId: string,
  opts: { imageTag?: string; imageDigest?: string; commitSha?: string } = {},
) {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO deployments
      (id, project_id, status, trigger, commit_sha, image_tag, image_digest, queued_at, finished_at, created_at, updated_at)
     VALUES (?, ?, 'succeeded', 'push', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    opts.commitSha ?? "c".repeat(40),
    opts.imageTag ?? "zixploy/proj:abc-dep1",
    opts.imageDigest ?? `sha256:${"f".repeat(64)}`,
    now,
    now,
    now,
    now,
  );
  return id;
}

// === POST /projects/:id/deploy ===
describe("POST /api/v1/projects/:id/deploy", () => {
  test("ต้อง login → 401", async () => {
    const { app, db } = await setup();
    const projectId = insertBareProject(db);
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/deploy`, { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  test("ต้อง CSRF → 403", async () => {
    const { app, db, cookie } = await setup();
    const projectId = insertBareProject(db);
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/deploy`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("project ยังไม่เชื่อมต่อ repository → 400 VALIDATION_ERROR", async () => {
    const { app, db, cookie, csrf } = await setup();
    const projectId = insertBareProject(db);
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/deploy`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("ข้อมูลครบ → 201 สร้าง deployment ด้วย commitSha ล่าสุดของ branch", async () => {
    const { app, db, cookie, csrf } = await setup();
    const installId = insertInstallation(db, 11111);
    const projectId = insertConnectedProject(db, { installationDbId: installId, branch: "main" });

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/deploy`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.projectId).toBe(projectId);
    expect(body.status).toBe("queued");
    expect(body.trigger).toBe("manual");
    expect(body.commitSha).toBe("a".repeat(40)); // main branch's commitSha ใน mock BRANCHES

    const job = db
      .query<{ status: string }, [string]>("SELECT status FROM deploy_jobs WHERE deployment_id = ?")
      .get(body.id);
    expect(job?.status).toBe("pending");
  });

  test("installation ถูก suspend → 502 GITHUB_UNAVAILABLE", async () => {
    const { app, db, cookie, csrf } = await setup();
    const installId = insertInstallation(db, 22222, { status: "suspended" });
    const projectId = insertConnectedProject(db, { installationDbId: installId });

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/deploy`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(res.status).toBe(502);
  });

  test("branch ไม่มีอยู่จริงบน GitHub → error (ไม่สร้าง deployment)", async () => {
    const { app, db, cookie, csrf } = await setup({ missingBranches: ["ghost-branch"] });
    const installId = insertInstallation(db, 33333);
    const projectId = insertConnectedProject(db, {
      installationDbId: installId,
      branch: "ghost-branch",
    });

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/deploy`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(res.status).toBe(404);
    const count = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM deployments WHERE project_id = ?")
      .get(projectId)!.n;
    expect(count).toBe(0);
  });

  test("มี deploy active อยู่แล้ว → 409 DEPLOY_ALREADY_ACTIVE", async () => {
    const { app, db, cookie, csrf } = await setup();
    const installId = insertInstallation(db, 44444);
    const projectId = insertConnectedProject(db, { installationDbId: installId });

    const first = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/deploy`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(first.status).toBe(201);

    const second = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/deploy`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(second.status).toBe(409);
  });
});

// === POST /projects/:id/redeploy ===
describe("POST /api/v1/projects/:id/redeploy", () => {
  test("ไม่เคย deploy มาก่อน → 400", async () => {
    const { app, db, cookie, csrf } = await setup();
    const installId = insertInstallation(db, 55555);
    const projectId = insertConnectedProject(db, { installationDbId: installId });

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/redeploy`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("เคย deploy แล้ว → 201 ใช้ commit เดิม", async () => {
    const { app, db, cookie, csrf } = await setup();
    const installId = insertInstallation(db, 66666);
    const projectId = insertConnectedProject(db, { installationDbId: installId });
    insertSucceededDeployment(db, projectId, { commitSha: "d".repeat(40) });

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/redeploy`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.commitSha).toBe("d".repeat(40));
    expect(body.trigger).toBe("redeploy");
  });
});

// === POST /projects/:id/restart, /stop ===
describe("POST /api/v1/projects/:id/restart", () => {
  test("ไม่มี succeeded deployment → 400", async () => {
    const { app, db, cookie, csrf } = await setup();
    const projectId = insertBareProject(db);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/restart`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("มี succeeded deployment → 200 { jobId }", async () => {
    const { app, db, cookie, csrf } = await setup();
    const projectId = insertBareProject(db);
    insertSucceededDeployment(db, projectId);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/restart`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(typeof body.jobId).toBe("string");
  });
});

describe("POST /api/v1/projects/:id/stop", () => {
  test("มี succeeded deployment → 200 { jobId } พร้อม payload kind=stop", async () => {
    const { app, db, cookie, csrf } = await setup();
    const projectId = insertBareProject(db);
    insertSucceededDeployment(db, projectId);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/stop`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);

    const job = db
      .query<{ payload: string }, [string]>("SELECT payload FROM deploy_jobs WHERE id = ?")
      .get(body.jobId);
    expect(JSON.parse(job!.payload)).toEqual({ kind: "stop" });
  });
});

// === POST /projects/:id/rollback ===
describe("POST /api/v1/projects/:id/rollback", () => {
  test("target ไม่ succeeded → 422 ROLLBACK_TARGET_UNAVAILABLE", async () => {
    const { app, db, cookie, csrf } = await setup();
    const projectId = insertBareProject(db);
    const failedId = ulid();
    const now = Date.now();
    db.query(
      `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
       VALUES (?, ?, 'failed', 'push', ?, ?, ?, ?)`,
    ).run(failedId, projectId, "e".repeat(40), now, now, now);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/rollback`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({ targetDeploymentId: failedId }),
      }),
    );
    expect(res.status).toBe(422);
  });

  test("target succeeded และมี image → 201 สร้าง deployment ใหม่พร้อม payload rollback", async () => {
    const { app, db, cookie, csrf } = await setup();
    const projectId = insertBareProject(db);
    const targetId = insertSucceededDeployment(db, projectId, {
      commitSha: "f".repeat(40),
      imageTag: "zixploy/proj:target-dep",
      imageDigest: "sha256:1234",
    });

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/rollback`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({ targetDeploymentId: targetId }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.trigger).toBe("rollback");
    expect(body.commitSha).toBe("f".repeat(40));

    const job = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM deploy_jobs WHERE deployment_id = ?",
      )
      .get(body.id);
    expect(JSON.parse(job!.payload)).toEqual({
      kind: "rollback",
      targetDeploymentId: targetId,
      imageTag: "zixploy/proj:target-dep",
      imageDigest: "sha256:1234",
    });
  });
});

// === POST /deployments/:id/cancel ===
describe("POST /api/v1/deployments/:id/cancel", () => {
  test("deployment ไม่มีอยู่ → 404", async () => {
    const { app, cookie, csrf } = await setup();
    const res = await app.handle(
      new Request("http://localhost/api/v1/deployments/01JBADIDNOTEXIST000000000/cancel", {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(res.status).toBe(404);
  });

  test("pending deployment → cancel สำเร็จ", async () => {
    const { app, db, cookie, csrf } = await setup();
    const installId = insertInstallation(db, 77777);
    const projectId = insertConnectedProject(db, { installationDbId: installId });

    const deployRes = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/deploy`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    const deployment = await json(deployRes);

    const cancelRes = await app.handle(
      new Request(`http://localhost/api/v1/deployments/${deployment.id}/cancel`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(cancelRes.status).toBe(200);
    const body = await json(cancelRes);
    expect(body.status).toBe("cancelled");
  });

  test("cancel ซ้ำ (idempotent) → ยัง 200 ไม่ throw", async () => {
    const { app, db, cookie, csrf } = await setup();
    const projectId = insertBareProject(db);
    const deploymentId = insertSucceededDeployment(db, projectId);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/deployments/${deploymentId}/cancel`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe("succeeded"); // terminal เดิมไม่เปลี่ยน
  });
});

// === GET /projects/:id/deployments ===
describe("GET /api/v1/projects/:id/deployments", () => {
  test("คืนรายการเรียงจากใหม่ไปเก่า", async () => {
    const { app, db, cookie } = await setup();
    const projectId = insertBareProject(db);
    const first = insertSucceededDeployment(db, projectId, { commitSha: "1".repeat(40) });
    await new Promise((r) => setTimeout(r, 2));
    const second = insertSucceededDeployment(db, projectId, { commitSha: "2".repeat(40) });

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/deployments`, {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.items).toHaveLength(2);
    expect(body.items[0].id).toBe(second);
    expect(body.items[1].id).toBe(first);
  });

  test("limit + nextCursor ทำงานถูกต้อง", async () => {
    const { app, db, cookie } = await setup();
    const projectId = insertBareProject(db);
    for (let i = 0; i < 5; i++) {
      insertSucceededDeployment(db, projectId, { commitSha: `${i}`.repeat(40) });
      await new Promise((r) => setTimeout(r, 2));
    }

    const firstPage = await json(
      await app.handle(
        new Request(`http://localhost/api/v1/projects/${projectId}/deployments?limit=2`, {
          headers: { cookie },
        }),
      ),
    );
    expect(firstPage.items).toHaveLength(2);
    expect(typeof firstPage.nextCursor).toBe("string");

    const secondPage = await json(
      await app.handle(
        new Request(
          `http://localhost/api/v1/projects/${projectId}/deployments?limit=2&cursor=${firstPage.nextCursor}`,
          { headers: { cookie } },
        ),
      ),
    );
    expect(secondPage.items).toHaveLength(2);
    // ไม่มี id ซ้ำข้ามหน้า
    const firstIds = new Set(firstPage.items.map((i: { id: string }) => i.id));
    for (const item of secondPage.items) {
      expect(firstIds.has(item.id)).toBe(false);
    }
  });
});

// === GET /deployments/:id ===
describe("GET /api/v1/deployments/:id", () => {
  test("ไม่มีอยู่ → 404", async () => {
    const { app, cookie } = await setup();
    const res = await app.handle(
      new Request("http://localhost/api/v1/deployments/01JBADIDNOTEXIST000000000", {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(404);
  });

  test("มีอยู่ → 200 คืน deployment เต็ม", async () => {
    const { app, db, cookie } = await setup();
    const projectId = insertBareProject(db);
    const deploymentId = insertSucceededDeployment(db, projectId);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/deployments/${deploymentId}`, { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.id).toBe(deploymentId);
    expect(body.status).toBe("succeeded");
    expect(body.imageTag).not.toBeNull();
  });
});
