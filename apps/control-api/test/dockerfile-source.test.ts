/**
 * Dockerfile-paste source (Phase 13) — routes/dockerfile-source.ts + routes/github.ts (mutual exclusive)
 * + branching ใน routes/deployments.ts (/deploy, /redeploy)
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { createMockRegistry, MOCK_APP_ID } from "./github-mock";
import { json } from "./helpers";

const DOCKERFILE = 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node", "index.js"]\n';

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

async function setup() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));

  const userId = ulid();
  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)",
  ).run(userId, await hashPassword("correct horse battery staple"), now, now);
  insertApp(db);

  const registry = createMockRegistry({});
  const app = buildApp(db, { registry });
  const { cookie, csrf } = await login(app);
  return { db, app, registry, cookie, csrf };
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

function request(
  method: string,
  path: string,
  auth: { cookie: string; csrf: string },
  body?: unknown,
) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: auth.cookie,
      "x-csrf-token": auth.csrf,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("POST/GET /projects/:id/source/dockerfile", () => {
  test("ตั้ง source เป็น dockerfile ที่วางเอง → source_type/dockerfile_content ถูกบันทึก และ dockerfile_path/build_context ถูกบังคับค่า", async () => {
    const { db, app, cookie, csrf } = await setup();
    const projectId = insertBareProject(db);

    const res = await app.handle(
      request(
        "POST",
        `/api/v1/projects/${projectId}/source/dockerfile`,
        { cookie, csrf },
        {
          dockerfile: DOCKERFILE,
        },
      ),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.sourceType).toBe("dockerfile");
    expect(body.dockerfile).toBe(DOCKERFILE);

    const row = db
      .query<
        {
          source_type: string;
          dockerfile_content: string;
          dockerfile_path: string;
          build_context: string;
        },
        [string]
      >(
        "SELECT source_type, dockerfile_content, dockerfile_path, build_context FROM projects WHERE id = ?",
      )
      .get(projectId);
    expect(row?.source_type).toBe("dockerfile");
    expect(row?.dockerfile_content).toBe(DOCKERFILE);
    expect(row?.dockerfile_path).toBe("Dockerfile");
    expect(row?.build_context).toBe(".");
  });

  test("GET คืนเนื้อหาที่บันทึกไว้ — sourceType เป็น 'github' ถ้ายังไม่เคยตั้ง dockerfile source", async () => {
    const { db, app, cookie, csrf } = await setup();
    const projectId = insertBareProject(db);

    const before = await app.handle(
      request("GET", `/api/v1/projects/${projectId}/source/dockerfile`, { cookie, csrf }),
    );
    expect((await json(before)).sourceType).toBe("github");
    expect(
      (
        await json(
          await app.handle(
            request("GET", `/api/v1/projects/${projectId}/source/dockerfile`, { cookie, csrf }),
          ),
        )
      ).dockerfile,
    ).toBeNull();

    await app.handle(
      request(
        "POST",
        `/api/v1/projects/${projectId}/source/dockerfile`,
        { cookie, csrf },
        {
          dockerfile: DOCKERFILE,
        },
      ),
    );

    const after = await app.handle(
      request("GET", `/api/v1/projects/${projectId}/source/dockerfile`, { cookie, csrf }),
    );
    const body = await json(after);
    expect(body.sourceType).toBe("dockerfile");
    expect(body.dockerfile).toBe(DOCKERFILE);
  });

  test("เนื้อหาว่างเปล่า → 400", async () => {
    const { db, app, cookie, csrf } = await setup();
    const projectId = insertBareProject(db);

    const res = await app.handle(
      request(
        "POST",
        `/api/v1/projects/${projectId}/source/dockerfile`,
        { cookie, csrf },
        {
          dockerfile: "",
        },
      ),
    );
    expect(res.status).toBe(400);
  });

  test("project ไม่มีอยู่จริง → 404", async () => {
    const { app, cookie, csrf } = await setup();
    const res = await app.handle(
      request(
        "POST",
        `/api/v1/projects/${ulid()}/source/dockerfile`,
        { cookie, csrf },
        { dockerfile: DOCKERFILE },
      ),
    );
    expect(res.status).toBe(404);
  });

  test("ไม่ login → 401", async () => {
    const { db, app } = await setup();
    const projectId = insertBareProject(db);
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/source/dockerfile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dockerfile: DOCKERFILE }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("mutual exclusivity — เชื่อม GitHub ทับ dockerfile source และกลับกัน", () => {
  test("เชื่อม GitHub repo หลังตั้ง dockerfile source ไว้ → dockerfile_content ถูกล้าง, source_type กลับเป็น github", async () => {
    const { db, app, cookie, csrf } = await setup();
    const projectId = insertBareProject(db);
    const installDbId = insertInstallation(db, 111);

    await app.handle(
      request(
        "POST",
        `/api/v1/projects/${projectId}/source/dockerfile`,
        { cookie, csrf },
        {
          dockerfile: DOCKERFILE,
        },
      ),
    );

    const res = await app.handle(
      request(
        "POST",
        `/api/v1/projects/${projectId}/source`,
        { cookie, csrf },
        {
          installationId: 111,
          repoId: 99999,
          repoFullName: "test-org/my-app",
          branch: "main",
        },
      ),
    );
    expect(res.status).toBe(200);
    expect((await json(res)).sourceType).toBe("github");

    const row = db
      .query<{ source_type: string; dockerfile_content: string | null }, [string]>(
        "SELECT source_type, dockerfile_content FROM projects WHERE id = ?",
      )
      .get(projectId);
    expect(row?.source_type).toBe("github");
    expect(row?.dockerfile_content).toBeNull();
    void installDbId;
  });

  test("ตั้ง dockerfile source หลังเชื่อม GitHub ไว้ → GitHub fields ทั้งหมดถูกล้าง", async () => {
    const { db, app, cookie, csrf } = await setup();
    const projectId = insertBareProject(db);
    insertInstallation(db, 111);

    await app.handle(
      request(
        "POST",
        `/api/v1/projects/${projectId}/source`,
        { cookie, csrf },
        {
          installationId: 111,
          repoId: 99999,
          repoFullName: "test-org/my-app",
          branch: "main",
        },
      ),
    );

    await app.handle(
      request(
        "POST",
        `/api/v1/projects/${projectId}/source/dockerfile`,
        { cookie, csrf },
        {
          dockerfile: DOCKERFILE,
        },
      ),
    );

    const row = db
      .query<
        {
          source_type: string;
          installation_id: string | null;
          repo_id: number | null;
          repo_full_name: string | null;
          branch: string | null;
        },
        [string]
      >(
        "SELECT source_type, installation_id, repo_id, repo_full_name, branch FROM projects WHERE id = ?",
      )
      .get(projectId);
    expect(row?.source_type).toBe("dockerfile");
    expect(row?.installation_id).toBeNull();
    expect(row?.repo_id).toBeNull();
    expect(row?.repo_full_name).toBeNull();
    expect(row?.branch).toBeNull();
  });

  test("DELETE /source (ยกเลิกการเชื่อมต่อ) หลังตั้ง dockerfile source → ล้างกลับเป็น baseline ทั้งหมด", async () => {
    const { db, app, cookie, csrf } = await setup();
    const projectId = insertBareProject(db);

    await app.handle(
      request(
        "POST",
        `/api/v1/projects/${projectId}/source/dockerfile`,
        { cookie, csrf },
        {
          dockerfile: DOCKERFILE,
        },
      ),
    );

    const res = await app.handle(
      request("DELETE", `/api/v1/projects/${projectId}/source`, { cookie, csrf }),
    );
    expect(res.status).toBe(200);

    const row = db
      .query<{ source_type: string; dockerfile_content: string | null }, [string]>(
        "SELECT source_type, dockerfile_content FROM projects WHERE id = ?",
      )
      .get(projectId);
    expect(row?.source_type).toBe("github");
    expect(row?.dockerfile_content).toBeNull();
  });
});

describe("POST /projects/:id/deploy — source แบบ dockerfile-paste", () => {
  test("deploy สำเร็จโดยไม่มี GitHub เกี่ยวข้องเลย — commitSha เป็น hash ของเนื้อหา, payload มี source.type=dockerfile", async () => {
    const { db, app, cookie, csrf } = await setup();
    const projectId = insertBareProject(db);

    await app.handle(
      request(
        "POST",
        `/api/v1/projects/${projectId}/source/dockerfile`,
        { cookie, csrf },
        {
          dockerfile: DOCKERFILE,
        },
      ),
    );

    const res = await app.handle(
      request("POST", `/api/v1/projects/${projectId}/deploy`, { cookie, csrf }),
    );
    expect(res.status).toBe(201);
    const deployment = await json(res);
    expect(deployment.commitSha).toMatch(/^[0-9a-f]{64}$/);

    const job = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM deploy_jobs WHERE deployment_id = ?",
      )
      .get(deployment.id);
    const payload = JSON.parse(job!.payload);
    expect(payload.kind).toBe("build");
    expect(payload.source).toEqual({ type: "dockerfile", dockerfileContent: DOCKERFILE });
  });

  test("ยังไม่ได้วาง Dockerfile และไม่ได้เชื่อม repo เลย → 400 VALIDATION_ERROR", async () => {
    const { db, app, cookie, csrf } = await setup();
    const projectId = insertBareProject(db);

    const res = await app.handle(
      request("POST", `/api/v1/projects/${projectId}/deploy`, { cookie, csrf }),
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  test("redeploy ใช้เนื้อหา Dockerfile ปัจจุบันเสมอ (ไม่ใช่ snapshot เก่า)", async () => {
    const { db, app, cookie, csrf } = await setup();
    const projectId = insertBareProject(db);

    await app.handle(
      request(
        "POST",
        `/api/v1/projects/${projectId}/source/dockerfile`,
        { cookie, csrf },
        {
          dockerfile: DOCKERFILE,
        },
      ),
    );
    const first = await json(
      await app.handle(request("POST", `/api/v1/projects/${projectId}/deploy`, { cookie, csrf })),
    );

    // จำลอง worker ทำ deployment แรกจบแล้ว (redeploy ต้องมี job ก่อนหน้าไม่ active ค้างอยู่)
    db.query("UPDATE deploy_jobs SET status = 'done' WHERE deployment_id = ?").run(first.id);
    db.query("UPDATE deployments SET status = 'succeeded', finished_at = ? WHERE id = ?").run(
      Date.now(),
      first.id,
    );

    // แก้ Dockerfile ใหม่ก่อน redeploy
    const updatedContent = `${DOCKERFILE}\nENV FOO=bar\n`;
    await app.handle(
      request(
        "POST",
        `/api/v1/projects/${projectId}/source/dockerfile`,
        { cookie, csrf },
        {
          dockerfile: updatedContent,
        },
      ),
    );

    const redeployRes = await app.handle(
      request("POST", `/api/v1/projects/${projectId}/redeploy`, { cookie, csrf }),
    );
    expect(redeployRes.status).toBe(201);
    const redeployed = await json(redeployRes);

    const job = db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM deploy_jobs WHERE deployment_id = ?",
      )
      .get(redeployed.id);
    const payload = JSON.parse(job!.payload);
    expect(payload.source.dockerfileContent).toBe(updatedContent);
    expect(redeployed.commitSha).not.toBe(first.commitSha);
  });
});
