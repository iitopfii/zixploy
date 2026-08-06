import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { createMockRegistry, MOCK_APP_ID } from "./github-mock";
import { json } from "./helpers";

const REPO: import("../src/github/service").Repository = {
  id: 99999,
  name: "my-app",
  fullName: "test-org/my-app",
  private: true,
  defaultBranch: "main",
  description: null,
};

const BRANCHES: import("../src/github/service").Branch[] = [
  { name: "main", protected: true, commitSha: "a".repeat(40) },
  { name: "develop", protected: false, commitSha: "b".repeat(40) },
];

/** สร้าง github_apps row ให้ FK ของ github_installations.github_app_id ผ่าน */
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

  const userId = await seedUser(db);
  insertApp(db);

  const registry = createMockRegistry({ repos: [REPO], branches: BRANCHES, ...mockOpts });
  const app = buildApp(db, { registry });

  const { cookie, csrf } = await login(app);
  return { db, app, registry, mock: registry.service, cookie, csrf, userId };
}

/** setup ที่ไม่มี GitHub App เลย (registry ว่าง) */
async function setupNoApps() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  await seedUser(db);

  const registry = createMockRegistry({ apps: [], ready: false });
  const app = buildApp(db, { registry });
  const { cookie, csrf } = await login(app);
  return { db, app, registry, cookie, csrf };
}

function insertInstallation(db: ReturnType<typeof openDatabase>, installationId: number) {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO github_installations
      (id, installation_id, account_login, account_type, account_avatar_url, status, github_app_id, created_at, updated_at)
     VALUES (?, ?, 'test-org', 'Organization', 'https://github.com/avatar.png', 'active', ?, ?, ?)`,
  ).run(id, installationId, MOCK_APP_ID, now, now);
  return id;
}

// === /github/status ===
describe("GET /api/v1/github/status", () => {
  test("configured: true เมื่อมี GitHub App", async () => {
    const { app } = await setup();
    const body = await json(await app.handle(new Request("http://localhost/api/v1/github/status")));
    expect(body.configured).toBe(true);
    expect(body.appCount).toBe(1);
    expect(body.masterKeyConfigured).toBe(true);
  });

  test("configured: false เมื่อยังไม่มี App", async () => {
    const { app } = await setupNoApps();
    const body = await json(await app.handle(new Request("http://localhost/api/v1/github/status")));
    expect(body.configured).toBe(false);
    expect(body.appCount).toBe(0);
    expect(body.masterKeyConfigured).toBe(false);
    expect(body.activeInstallationCount).toBe(0);
  });

  test("activeInstallationCount นับเฉพาะ active", async () => {
    const { app, db } = await setup();
    insertInstallation(db, 11111);
    insertInstallation(db, 22222);
    const deletedId = ulid();
    db.query(
      `INSERT INTO github_installations
        (id, installation_id, account_login, account_type, account_avatar_url, status, github_app_id, created_at, updated_at)
       VALUES (?, 33333, 'deleted-org', 'User', '', 'deleted', ?, ?, ?)`,
    ).run(deletedId, MOCK_APP_ID, Date.now(), Date.now());

    const body = await json(await app.handle(new Request("http://localhost/api/v1/github/status")));
    expect(body.activeInstallationCount).toBe(2);
  });
});

// === /github/apps ===
describe("GET /api/v1/github/apps", () => {
  test("ต้อง login ก่อน → 401", async () => {
    const { app } = await setup();
    const res = await app.handle(new Request("http://localhost/api/v1/github/apps"));
    expect(res.status).toBe(401);
  });

  test("คืนรายการ apps โดยไม่มี secret ใดๆ", async () => {
    const { app, cookie } = await setup();
    const res = await app.handle(
      new Request("http://localhost/api/v1/github/apps", { headers: { cookie } }),
    );
    const text = await res.text();
    const body = JSON.parse(text) as { items: Record<string, unknown>[] };

    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.slug).toBe("test-app");
    expect(body.items[0]!.appId).toBe(123456);
    // ไม่มี secret field ใดๆ ใน response
    expect(body.items[0]).not.toHaveProperty("pem");
    expect(body.items[0]).not.toHaveProperty("clientSecret");
    expect(body.items[0]).not.toHaveProperty("webhookSecret");
    expect(text).not.toContain("BEGIN RSA");
    expect(text).not.toContain("BEGIN PRIVATE");
  });
});

// === POST /github/apps/manifest ===
describe("POST /api/v1/github/apps/manifest", () => {
  test("ต้อง login → 401", async () => {
    const { app } = await setup();
    const res = await app.handle(
      new Request("http://localhost/api/v1/github/apps/manifest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "My App" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("ต้อง CSRF → 403", async () => {
    const { app, cookie } = await setup();
    const res = await app.handle(
      new Request("http://localhost/api/v1/github/apps/manifest", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "My App" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("คืน manifest form พร้อม action + state", async () => {
    const { app, cookie, csrf } = await setup();
    const body = await json(
      await app.handle(
        new Request("http://localhost/api/v1/github/apps/manifest", {
          method: "POST",
          headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
          body: JSON.stringify({ name: "My Zixploy" }),
        }),
      ),
    );
    expect(body.action).toContain("github.com/settings/apps/new");
    expect(typeof body.state).toBe("string");
    const manifest = JSON.parse(body.manifest as string) as { name: string };
    expect(manifest.name).toBe("My Zixploy");
  });

  test("organization → action ชี้ไปที่ org settings", async () => {
    const { app, cookie, csrf } = await setup();
    const body = await json(
      await app.handle(
        new Request("http://localhost/api/v1/github/apps/manifest", {
          method: "POST",
          headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
          body: JSON.stringify({ name: "Org App", organization: "my-org" }),
        }),
      ),
    );
    expect(body.action).toContain("organizations/my-org/settings/apps/new");
  });

  test("master key ไม่ configure → 502", async () => {
    const { app, cookie, csrf } = await setupNoApps();
    const res = await app.handle(
      new Request("http://localhost/api/v1/github/apps/manifest", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify({ name: "My App" }),
      }),
    );
    expect(res.status).toBe(502);
  });
});

// === GET /github/apps/callback ===
describe("GET /api/v1/github/apps/callback", () => {
  test("ขาด code/state → redirect พร้อม error", async () => {
    const { app, cookie } = await setup();
    const res = await app.handle(
      new Request("http://localhost/api/v1/github/apps/callback", { headers: { cookie } }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("manifest-error");
  });

  test("state ผิด → redirect พร้อม error", async () => {
    const { app, cookie } = await setup();
    const res = await app.handle(
      new Request("http://localhost/api/v1/github/apps/callback?code=abc&state=wrong-state", {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("manifest-error");
  });

  test("code+state ถูกต้อง → redirect พร้อม app-created", async () => {
    const { app, cookie } = await setup();
    const res = await app.handle(
      new Request("http://localhost/api/v1/github/apps/callback?code=abc&state=mock-state", {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("app-created");
  });
});

// === /github/apps/:id/install-url ===
describe("GET /api/v1/github/apps/:id/install-url", () => {
  test("ต้อง login ก่อน → 401", async () => {
    const { app } = await setup();
    const res = await app.handle(
      new Request(`http://localhost/api/v1/github/apps/${MOCK_APP_ID}/install-url`),
    );
    expect(res.status).toBe(401);
  });

  test("login แล้ว → ได้ URL", async () => {
    const { app, cookie } = await setup();
    const body = await json(
      await app.handle(
        new Request(`http://localhost/api/v1/github/apps/${MOCK_APP_ID}/install-url`, {
          headers: { cookie },
        }),
      ),
    );
    expect(typeof body.url).toBe("string");
    expect(body.url).toContain("github.com/apps");
  });

  test("app ไม่มีอยู่ → 404", async () => {
    const { app, cookie } = await setup();
    const res = await app.handle(
      new Request("http://localhost/api/v1/github/apps/01JBQZXNOTEXIST00000000000/install-url", {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(404);
  });
});

// === DELETE /github/apps/:id ===
describe("DELETE /api/v1/github/apps/:id", () => {
  test("ต้อง CSRF → 403", async () => {
    const { app, cookie } = await setup();
    const res = await app.handle(
      new Request(`http://localhost/api/v1/github/apps/${MOCK_APP_ID}`, {
        method: "DELETE",
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("ลบสำเร็จ → ok:true", async () => {
    const { app, cookie, csrf } = await setup();
    const body = await json(
      await app.handle(
        new Request(`http://localhost/api/v1/github/apps/${MOCK_APP_ID}`, {
          method: "DELETE",
          headers: { cookie, "x-csrf-token": csrf },
        }),
      ),
    );
    expect(body.ok).toBe(true);
  });

  test("app ไม่มีอยู่ → 404", async () => {
    const { app, cookie, csrf } = await setup();
    const res = await app.handle(
      new Request("http://localhost/api/v1/github/apps/01JBQZXNOTEXIST00000000000", {
        method: "DELETE",
        headers: { cookie, "x-csrf-token": csrf },
      }),
    );
    expect(res.status).toBe(404);
  });
});

// === /github/installations ===
describe("GET /api/v1/github/installations", () => {
  test("ต้อง login → 401", async () => {
    const { app } = await setup();
    const res = await app.handle(new Request("http://localhost/api/v1/github/installations"));
    expect(res.status).toBe(401);
  });

  test("คืน installations ที่ active และ suspended (ไม่รวม deleted)", async () => {
    const { app, db, cookie } = await setup();
    insertInstallation(db, 11111);
    insertInstallation(db, 22222);

    const deletedId = ulid();
    db.query(
      `INSERT INTO github_installations
        (id, installation_id, account_login, account_type, account_avatar_url, status, github_app_id, created_at, updated_at)
       VALUES (?, 33333, 'gone-org', 'User', '', 'deleted', ?, ?, ?)`,
    ).run(deletedId, MOCK_APP_ID, Date.now(), Date.now());

    const body = await json(
      await app.handle(
        new Request("http://localhost/api/v1/github/installations", {
          headers: { cookie },
        }),
      ),
    );
    expect(body.items).toHaveLength(2);
    expect(body.items.every((i: Record<string, unknown>) => i.status !== "deleted")).toBe(true);
  });

  test("installation แสดง appId + appName ของ GitHub App ที่ผูกอยู่", async () => {
    const { app, db, cookie } = await setup();
    insertInstallation(db, 11111);

    const body = await json(
      await app.handle(
        new Request("http://localhost/api/v1/github/installations", { headers: { cookie } }),
      ),
    );
    expect(body.items[0].appId).toBe(MOCK_APP_ID);
    expect(body.items[0].appName).toBe("Test App");
  });
});

// === /github/installations/:id/repositories ===
describe("GET /api/v1/github/installations/:id/repositories", () => {
  test("installation ไม่อยู่ใน DB → 404", async () => {
    const { app, cookie } = await setup();
    const res = await app.handle(
      new Request("http://localhost/api/v1/github/installations/99999/repositories", {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(404);
  });

  test("installation ถูก suspend → 502", async () => {
    const { app, db, cookie } = await setup();
    const id = ulid();
    db.query(
      `INSERT INTO github_installations
        (id, installation_id, account_login, account_type, account_avatar_url, status, github_app_id, created_at, updated_at)
       VALUES (?, 55555, 'org', 'Organization', '', 'suspended', ?, ?, ?)`,
    ).run(id, MOCK_APP_ID, Date.now(), Date.now());

    const res = await app.handle(
      new Request("http://localhost/api/v1/github/installations/55555/repositories", {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(502);
  });

  test("installation active → คืน repos จาก mock", async () => {
    const { app, db, cookie } = await setup();
    insertInstallation(db, 11111);

    const body = await json(
      await app.handle(
        new Request("http://localhost/api/v1/github/installations/11111/repositories", {
          headers: { cookie },
        }),
      ),
    );
    expect(body.items).toHaveLength(1);
    expect(body.items[0].fullName).toBe("test-org/my-app");
    expect(body.items[0].private).toBe(true);
    expect(typeof body.totalCount).toBe("number");
  });

  test("GitHub API error → 502", async () => {
    const { app, db, cookie } = await setup({ listReposError: true });
    insertInstallation(db, 22222);

    const res = await app.handle(
      new Request("http://localhost/api/v1/github/installations/22222/repositories", {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(502);
  });

  test("GitHub App ของ installation ไม่พร้อม → 502", async () => {
    const { app, db, cookie } = await setup({ serviceUnavailable: true });
    insertInstallation(db, 33333);

    const res = await app.handle(
      new Request("http://localhost/api/v1/github/installations/33333/repositories", {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(502);
  });
});

// === /github/branches ===
describe("GET /api/v1/github/branches", () => {
  test("คืน branches จาก mock", async () => {
    const { app, cookie } = await setup();
    const body = await json(
      await app.handle(
        new Request(
          "http://localhost/api/v1/github/branches?installationId=11111&repo=test-org/my-app",
          { headers: { cookie } },
        ),
      ),
    );
    expect(body.items).toHaveLength(2);
    expect(body.items[0].name).toBe("main");
  });

  test("ขาด repo param → 400", async () => {
    const { app, cookie } = await setup();
    const res = await app.handle(
      new Request("http://localhost/api/v1/github/branches?installationId=11111", {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(400);
  });
});

// === POST /projects/:id/source ===
describe("POST /api/v1/projects/:id/source", () => {
  async function createProject(app: ReturnType<typeof buildApp>, cookie: string, csrf: string) {
    const res = await app.handle(
      new Request("http://localhost/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify({ name: "test" }),
      }),
    );
    return json(res);
  }

  test("ต้อง CSRF → 403", async () => {
    const { app, db, cookie, csrf } = await setup();
    insertInstallation(db, 11111);
    const project = await createProject(app, cookie, csrf);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${project.id}/source`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie }, // ไม่มี CSRF
        body: JSON.stringify({
          installationId: 11111,
          repoId: 99999,
          repoFullName: "test-org/my-app",
          branch: "main",
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("installation ไม่อยู่ใน DB → 404", async () => {
    const { app, cookie, csrf } = await setup();
    const project = await createProject(app, cookie, csrf);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${project.id}/source`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify({
          installationId: 99999,
          repoId: 99999,
          repoFullName: "test-org/my-app",
          branch: "main",
        }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("repo ไม่มีสิทธิ์เข้าถึง → 404", async () => {
    const { app, db, cookie, csrf } = await setup({ forbiddenRepos: ["test-org/my-app"] });
    insertInstallation(db, 11111);
    const project = await createProject(app, cookie, csrf);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${project.id}/source`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify({
          installationId: 11111,
          repoId: 99999,
          repoFullName: "test-org/my-app",
          branch: "main",
        }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("branch ไม่มีอยู่ → 404", async () => {
    const { app, db, cookie, csrf } = await setup({ missingBranches: ["nonexistent"] });
    insertInstallation(db, 11111);
    const project = await createProject(app, cookie, csrf);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${project.id}/source`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify({
          installationId: 11111,
          repoId: 99999,
          repoFullName: "test-org/my-app",
          branch: "nonexistent",
        }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("ข้อมูลถูกต้อง → project ได้รับการ update", async () => {
    const { app, db, cookie, csrf } = await setup();
    insertInstallation(db, 11111);
    const project = await createProject(app, cookie, csrf);

    const body = await json(
      await app.handle(
        new Request(`http://localhost/api/v1/projects/${project.id}/source`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
          body: JSON.stringify({
            installationId: 11111,
            repoId: 99999,
            repoFullName: "test-org/my-app",
            branch: "main",
          }),
        }),
      ),
    );

    expect(body.repoFullName).toBe("test-org/my-app");
    expect(body.branch).toBe("main");
    expect(body.repoId).toBe(99999);
    expect(body.installationId).not.toBeNull();
  });

  test("repoId ไม่ตรงกับ repo ที่ GitHub API คืน → 400", async () => {
    const { app, db, cookie, csrf } = await setup();
    insertInstallation(db, 11111);
    const project = await createProject(app, cookie, csrf);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${project.id}/source`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify({
          installationId: 11111,
          repoId: 12345,
          repoFullName: "test-org/my-app",
          branch: "main",
        }),
        // repoId 12345 ≠ mock returns 99999
      }),
    );
    expect(res.status).toBe(400);
  });
});

// === DELETE /projects/:id/source ===
describe("DELETE /api/v1/projects/:id/source", () => {
  async function createConnectedProject(
    app: ReturnType<typeof buildApp>,
    db: ReturnType<typeof openDatabase>,
    cookie: string,
    csrf: string,
  ) {
    // Create project
    const createRes = await app.handle(
      new Request("http://localhost/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify({ name: "connected" }),
      }),
    );
    const project = await json(createRes);

    // Insert installation
    insertInstallation(db, 11111);

    // Connect source
    await app.handle(
      new Request(`http://localhost/api/v1/projects/${project.id}/source`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify({
          installationId: 11111,
          repoId: 99999,
          repoFullName: "test-org/my-app",
          branch: "main",
        }),
      }),
    );

    return project;
  }

  test("ต้อง CSRF → 403", async () => {
    const { app, db, cookie, csrf } = await setup();
    const project = await createConnectedProject(app, db, cookie, csrf);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${project.id}/source`, {
        method: "DELETE",
        headers: { cookie }, // ไม่มี CSRF
      }),
    );
    expect(res.status).toBe(403);
  });

  test("disconnect → repo fields เป็น null", async () => {
    const { app, db, cookie, csrf } = await setup();
    const project = await createConnectedProject(app, db, cookie, csrf);

    const body = await json(
      await app.handle(
        new Request(`http://localhost/api/v1/projects/${project.id}/source`, {
          method: "DELETE",
          headers: { cookie, "x-csrf-token": csrf },
        }),
      ),
    );

    expect(body.repoFullName).toBeNull();
    expect(body.branch).toBeNull();
    expect(body.repoId).toBeNull();
    expect(body.installationId).toBeNull();
  });
});

// === Secrets ไม่หลุดใน response ===
describe("secrets ไม่ปรากฏใน GitHub API responses", () => {
  test("install-url ไม่มี token ใน response body", async () => {
    const { app, cookie } = await setup();
    const res = await app.handle(
      new Request(`http://localhost/api/v1/github/apps/${MOCK_APP_ID}/install-url`, {
        headers: { cookie },
      }),
    );
    const text = await res.text();
    // mock token ชื่อ "ghp_" จะไม่มีใน response
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("Bearer ");
  });

  test("manifest response ไม่มี PEM หรือ client secret", async () => {
    const { app, cookie, csrf } = await setup();
    const res = await app.handle(
      new Request("http://localhost/api/v1/github/apps/manifest", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        body: JSON.stringify({ name: "Secret Test" }),
      }),
    );
    const text = await res.text();
    expect(text).not.toContain("BEGIN RSA");
    expect(text).not.toContain("BEGIN PRIVATE");
    expect(text).not.toContain("client_secret");
  });
});
