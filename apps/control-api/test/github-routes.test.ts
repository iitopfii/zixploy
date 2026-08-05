import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { createMockGitHub } from "./github-mock";
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
  { name: "main", protected: true },
  { name: "develop", protected: false },
];

async function setup(mockOpts: Parameters<typeof createMockGitHub>[0] = {}) {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));

  const userId = ulid();
  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(userId, "admin", await hashPassword("correct horse battery staple"), now, now);

  const mock = createMockGitHub({ repos: [REPO], branches: BRANCHES, ...mockOpts });
  const app = buildApp(db, { github: mock, webhookSecret: "test-secret" });

  // Login
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
  const csrf = cookies.zx_csrf ?? "";

  return { db, app, mock, cookie, csrf, userId };
}

function insertInstallation(db: ReturnType<typeof openDatabase>, installationId: number) {
  const id = ulid();
  const now = Date.now();
  db.query(
    "INSERT INTO github_installations (id, installation_id, account_login, account_type, account_avatar_url, status, created_at, updated_at) VALUES (?, ?, 'test-org', 'Organization', 'https://github.com/avatar.png', 'active', ?, ?)",
  ).run(id, installationId, now, now);
  return id;
}

// === /github/status ===
describe("GET /api/v1/github/status", () => {
  test("configured: true เมื่อมี github service", async () => {
    const { app } = await setup();
    const body = await json(await app.handle(new Request("http://localhost/api/v1/github/status")));
    expect(body.configured).toBe(true);
  });

  test("configured: false เมื่อไม่มี github service", async () => {
    const db = openDatabase({ path: ":memory:" });
    migrateUp(db, loadMigrations(migrationsDir()));
    const app = buildApp(db); // ไม่มี github
    const body = await json(await app.handle(new Request("http://localhost/api/v1/github/status")));
    expect(body.configured).toBe(false);
    expect(body.activeInstallationCount).toBe(0);
  });

  test("activeInstallationCount นับเฉพาะ active", async () => {
    const { app, db } = await setup();
    insertInstallation(db, 11111);
    insertInstallation(db, 22222);
    // เพิ่ม deleted installation
    const deletedId = ulid();
    db.query(
      "INSERT INTO github_installations (id, installation_id, account_login, account_type, account_avatar_url, status, created_at, updated_at) VALUES (?, 33333, 'deleted-org', 'User', '', 'deleted', ?, ?)",
    ).run(deletedId, Date.now(), Date.now());

    const body = await json(await app.handle(new Request("http://localhost/api/v1/github/status")));
    expect(body.activeInstallationCount).toBe(2);
  });
});

// === /github/install-url ===
describe("GET /api/v1/github/install-url", () => {
  test("ต้อง login ก่อน → 401", async () => {
    const { app } = await setup();
    const res = await app.handle(new Request("http://localhost/api/v1/github/install-url"));
    expect(res.status).toBe(401);
  });

  test("login แล้ว → ได้ URL", async () => {
    const { app, cookie, csrf } = await setup();
    const body = await json(
      await app.handle(
        new Request("http://localhost/api/v1/github/install-url", {
          headers: { cookie, "x-csrf-token": csrf },
        }),
      ),
    );
    expect(typeof body.url).toBe("string");
    expect(body.url).toContain("github.com/apps");
  });

  test("ไม่มี github service → 502", async () => {
    const db = openDatabase({ path: ":memory:" });
    migrateUp(db, loadMigrations(migrationsDir()));
    const userId = ulid();
    const now = Date.now();
    db.query(
      "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(userId, "admin", await hashPassword("correct horse battery staple"), now, now);

    const app = buildApp(db); // no github
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
    const cookie2 = Object.entries(cookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("; ");

    const res = await app.handle(
      new Request("http://localhost/api/v1/github/install-url", {
        headers: { cookie: cookie2 },
      }),
    );
    expect(res.status).toBe(502);
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
      "INSERT INTO github_installations (id, installation_id, account_login, account_type, account_avatar_url, status, created_at, updated_at) VALUES (?, 33333, 'gone-org', 'User', '', 'deleted', ?, ?)",
    ).run(deletedId, Date.now(), Date.now());

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
      "INSERT INTO github_installations (id, installation_id, account_login, account_type, account_avatar_url, status, created_at, updated_at) VALUES (?, 55555, 'org', 'Organization', '', 'suspended', ?, ?)",
    ).run(id, Date.now(), Date.now());

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
      new Request("http://localhost/api/v1/github/install-url", {
        headers: { cookie },
      }),
    );
    const text = await res.text();
    // mock token ชื่อ "ghp_" จะไม่มีใน response
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("Bearer ");
  });
});
