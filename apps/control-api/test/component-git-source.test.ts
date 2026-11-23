/**
 * repo/branch ต่อ build component (gitSource, 0.1.25) — HTTP round-trip
 *
 * ครอบ: สร้าง/แก้/ล้าง gitSource, ตรวจกับ GitHub ก่อนบันทึก (repo/branch ไม่มี = ไม่บันทึก), รูปแบบผิด
 * ได้ 422 โดยไม่ถาม GitHub, ใช้กับ component ที่ไม่ใช่ build ไม่ได้, installation ไม่มี/ไม่ active
 * และ redeploy ปัก commit ของ component จาก deployment ก่อน
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { createMockRegistry, MOCK_APP_ID } from "./github-mock";
import { json } from "./helpers";

const FRONTEND = {
  id: 4242,
  name: "frontend",
  fullName: "test-org/frontend",
  private: true,
  defaultBranch: "main",
  description: null,
};
const BACKEND = { ...FRONTEND, id: 4141, name: "backend", fullName: "test-org/backend" };

async function setup() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)",
  ).run(ulid(), await hashPassword("adminpass123"), now, now);
  db.query(
    `INSERT INTO github_apps (id, app_id, slug, name, html_url, owner_login, client_id,
       pem_ciphertext, webhook_secret_ciphertext, client_secret_ciphertext, created_at, updated_at)
     VALUES (?, 123456, 'test-app', 'Test App', 'https://github.com/apps/test-app', 'test-org', 'Iv1.test',
             ?, ?, ?, ?, ?)`,
  ).run(MOCK_APP_ID, new Uint8Array([1]), new Uint8Array([1]), new Uint8Array([1]), now, now);
  const installRowId = ulid();
  db.query(
    `INSERT INTO github_installations
      (id, installation_id, account_login, account_type, account_avatar_url, status, github_app_id, created_at, updated_at)
     VALUES (?, 777, 'test-org', 'Organization', 'https://github.com/avatar.png', 'active', ?, ?, ?)`,
  ).run(installRowId, MOCK_APP_ID, now, now);
  db.query(
    `INSERT INTO github_installations
      (id, installation_id, account_login, account_type, account_avatar_url, status, github_app_id, created_at, updated_at)
     VALUES (?, 888, 'other', 'Organization', 'https://github.com/avatar.png', 'suspended', ?, ?, ?)`,
  ).run(ulid(), MOCK_APP_ID, now, now);

  const projectId = ulid();
  db.query(
    `INSERT INTO projects (id, name, status, mode, source_type, installation_id, repo_id, repo_full_name, branch,
       dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'app', 'new', 'compose', 'github', ?, 4141, 'test-org/backend', 'main',
       'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(projectId, installRowId, now, now);

  const registry = createMockRegistry({ repos: [BACKEND, FRONTEND] });
  const app = buildApp(db, { registry });
  const res = await app.handle(
    new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "adminpass123" }),
    }),
  );
  const cookies: Record<string, string> = {};
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (pair && eq > 0) cookies[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
  const csrf = cookies.zx_csrf ?? "";
  const call = (method: string, path: string, body?: unknown) =>
    app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}${path}`, {
        method,
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
  return { db, projectId, call };
}

const WEB_SOURCE = { installationId: 777, repoFullName: "test-org/frontend", branch: "main" };

describe("component gitSource", () => {
  test("สร้าง build component พร้อม repo ของตัวเอง → DTO คืน gitSource (installation เป็นตัวเลข)", async () => {
    const { db, call } = await setup();
    const res = await call("POST", "/components", {
      name: "web",
      sourceKind: "build",
      isWeb: true,
      webPort: 3000,
      gitSource: WEB_SOURCE,
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.gitSource).toEqual(WEB_SOURCE);
    const row = db
      .query<{ repo_full_name: string; repo_branch: string }, [string]>(
        "SELECT repo_full_name, repo_branch FROM project_components WHERE id = ?",
      )
      .get(body.id);
    expect(row).toEqual({ repo_full_name: "test-org/frontend", repo_branch: "main" });

    const list = await json(await call("GET", "/components"));
    expect(list.items[0].gitSource).toEqual(WEB_SOURCE);
  });

  test("ไม่ตั้ง → gitSource null (ใช้ repo ของ project)", async () => {
    const { call } = await setup();
    const body = await json(
      await call("POST", "/components", { name: "api", sourceKind: "build" }),
    );
    expect(body.gitSource).toBeNull();
  });

  test("repo หรือ branch ที่ installation เข้าไม่ถึง → ไม่บันทึก", async () => {
    const { db, call } = await setup();
    const badRepo = await call("POST", "/components", {
      name: "web",
      sourceKind: "build",
      gitSource: { ...WEB_SOURCE, repoFullName: "test-org/nope" },
    });
    expect(badRepo.status).toBe(404);
    const badBranch = await call("POST", "/components", {
      name: "web",
      sourceKind: "build",
      gitSource: { ...WEB_SOURCE, branch: "does-not-exist" },
    });
    expect(badBranch.status).toBe(404);
    expect(db.query("SELECT COUNT(*) AS n FROM project_components").get()).toEqual({ n: 0 });
  });

  test("รูปแบบผิด → 422 COMPONENT_INVALID", async () => {
    const { call } = await setup();
    for (const gitSource of [
      { ...WEB_SOURCE, branch: "-upload-pack=x" },
      { ...WEB_SOURCE, branch: "a..b" },
      { ...WEB_SOURCE, repoFullName: "no-slash" },
    ]) {
      const res = await call("POST", "/components", {
        name: "web",
        sourceKind: "build",
        gitSource,
      });
      expect(res.status).toBe(422);
      expect((await json(res)).error.code).toBe("COMPONENT_INVALID");
    }
  });

  test("component แบบ image ตั้ง repo ไม่ได้", async () => {
    const { call } = await setup();
    const res = await call("POST", "/components", {
      name: "redis",
      sourceKind: "image",
      imageRef: "redis:7.4-alpine",
      gitSource: WEB_SOURCE,
    });
    expect(res.status).toBe(422);
  });

  test("installation ไม่มีในระบบ หรือไม่ active → ไม่บันทึก", async () => {
    const { call } = await setup();
    const unknown = await call("POST", "/components", {
      name: "web",
      sourceKind: "build",
      gitSource: { ...WEB_SOURCE, installationId: 999 },
    });
    expect(unknown.status).toBe(404);
    const suspended = await call("POST", "/components", {
      name: "web",
      sourceKind: "build",
      gitSource: { ...WEB_SOURCE, installationId: 888 },
    });
    expect(suspended.status).toBe(502);
  });

  test("PATCH ตั้งแล้วล้างกลับเป็น null ได้ · PATCH field อื่นไม่แตะ gitSource", async () => {
    const { call } = await setup();
    const created = await json(
      await call("POST", "/components", { name: "web", sourceKind: "build" }),
    );
    const set = await json(
      await call("PATCH", `/components/${created.id}`, { gitSource: WEB_SOURCE }),
    );
    expect(set.gitSource).toEqual(WEB_SOURCE);
    const other = await json(
      await call("PATCH", `/components/${created.id}`, { targetStage: "runtime" }),
    );
    expect(other.gitSource).toEqual(WEB_SOURCE);
    const cleared = await json(
      await call("PATCH", `/components/${created.id}`, { gitSource: null }),
    );
    expect(cleared.gitSource).toBeNull();
  });
});

describe("redeploy + component commits", () => {
  test("redeploy ส่ง commit ของ component จาก deployment ก่อนไปใน payload และ DTO แสดง componentCommits", async () => {
    const { db, projectId, call } = await setup();
    const web = await json(
      await call("POST", "/components", {
        name: "web",
        sourceKind: "build",
        isWeb: true,
        webPort: 3000,
        gitSource: WEB_SOURCE,
      }),
    );
    const now = Date.now();
    const prevId = ulid();
    const pinned = "e".repeat(40);
    db.query(
      `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, component_commits, queued_at, finished_at, created_at, updated_at)
       VALUES (?, ?, 'succeeded', 'manual', ?, ?, ?, ?, ?, ?)`,
    ).run(
      prevId,
      projectId,
      "a".repeat(40),
      JSON.stringify({ [web.id]: pinned }),
      now,
      now,
      now,
      now,
    );

    const res = await call("POST", "/redeploy");
    expect(res.status).toBe(201);
    const dep = await json(res);
    const job = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM deploy_jobs WHERE deployment_id = ?",
      )
      .get(dep.id);
    expect(JSON.parse(job?.payload ?? "{}").componentCommits).toEqual({ [web.id]: pinned });

    const prev = await json(await call("GET", "/deployments"));
    const prevDto = prev.items.find((d: { id: string }) => d.id === prevId);
    expect(prevDto.componentCommits).toEqual({ [web.id]: pinned });
  });
});
