/**
 * Environment Variables API — HTTP round-trip tests
 *
 * ตรวจสอบ:
 * - GET คืน metadata เท่านั้น (ไม่มี plaintext)
 * - PUT เข้ารหัสก่อน persist — DB dump ไม่มี plaintext
 * - PUT replace ทั้งหมดใน transaction
 * - Import parse .env ได้ถูกต้อง (ไม่แตะ DB)
 * - Validate คืน error list ถูกต้อง
 * - Encryption not configured → 503 สำหรับ PUT
 * - PROJECT_NOT_FOUND → 404
 * - Key ซ้ำ → 409, Key format ผิด → 422
 * - AAD binding: ciphertext ย้ายข้าม project ไม่ได้
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { createMasterKeys } from "../src/crypto/master-key";
import { decryptEnvVarsForWorker } from "../src/env/store";
import { json } from "./helpers";

// ---------------------------------------------------------------------------
// Setup helpers (pattern เดียวกับ deployment-routes.test.ts)
// ---------------------------------------------------------------------------

async function makeKeys() {
  return createMasterKeys(1, { 1: new Uint8Array(32).fill(0x42) });
}

async function login(app: ReturnType<typeof buildApp>) {
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
  return { cookie, csrf: cookies.zx_csrf ?? "" };
}

async function setup(opts: { withKeys?: boolean } = {}) {
  const withKeys = opts.withKeys ?? true;
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
     VALUES (?, 'test-proj', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(projectId, now, now);

  const masterKeys = withKeys ? await makeKeys() : null;
  const app = buildApp(db, { masterKeys });
  const { cookie, csrf } = await login(app);

  return { db, app, masterKeys, projectId, cookie, csrf };
}

// ---------------------------------------------------------------------------
// GET /projects/:id/environment
// ---------------------------------------------------------------------------

describe("GET /projects/:id/environment", () => {
  test("empty list เมื่อยังไม่มี vars", async () => {
    const { app, projectId, cookie } = await setup();
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/environment`, {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.variables).toEqual([]);
  });

  test("คืน metadata ไม่คืน plaintext — hasValue=true, ไม่มี field value", async () => {
    const { app, projectId, cookie, csrf } = await setup();

    await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/environment`, {
        method: "PUT",
        headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({
          variables: [{ key: "SECRET_KEY", value: "super-secret-value", isSecret: true }],
        }),
      }),
    );

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/environment`, {
        headers: { cookie },
      }),
    );
    const body = await json(res);
    expect(body.variables).toHaveLength(1);
    const v = body.variables[0];
    expect(v.hasValue).toBe(true);
    expect(v.key).toBe("SECRET_KEY");
    expect(v.isSecret).toBe(true);
    expect(v.value).toBeUndefined();
    expect(v.plaintext).toBeUndefined();
  });

  test("404 เมื่อ project ไม่มีอยู่", async () => {
    const { app, cookie } = await setup();
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${ulid()}/environment`, {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(404);
  });

  test("GET ทำงานได้แม้ไม่มี masterKeys", async () => {
    const { app, projectId, cookie } = await setup({ withKeys: false });
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/environment`, {
        headers: { cookie },
      }),
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PUT /projects/:id/environment
// ---------------------------------------------------------------------------

describe("PUT /projects/:id/environment", () => {
  function put(
    app: ReturnType<typeof buildApp>,
    projectId: string,
    cookie: string,
    csrf: string,
    variables: unknown[],
  ) {
    return app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/environment`, {
        method: "PUT",
        headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({ variables }),
      }),
    );
  }

  test("replace ทั้งชุดสำเร็จ — คืน list ใหม่", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await put(app, projectId, cookie, csrf, [
      { key: "A", value: "hello" },
      { key: "B", value: "world", isSecret: true, scope: "build" },
    ]);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.variables).toHaveLength(2);
    expect(body.variables[0].key).toBe("A"); // sorted by key
    expect(body.variables[1].key).toBe("B");
    expect(body.variables[1].isSecret).toBe(true);
    expect(body.variables[1].scope).toBe("build");
  });

  test("plaintext ไม่ปรากฏใน DB — value_ciphertext ต้องเป็น BLOB ที่ไม่ใช่ plaintext", async () => {
    const { app, db, projectId, cookie, csrf } = await setup();
    await put(app, projectId, cookie, csrf, [{ key: "DB_PASS", value: "mysecretpassword123" }]);

    const row = db
      .query<{ value_ciphertext: Buffer }, [string, string]>(
        "SELECT value_ciphertext FROM environment_variables WHERE project_id = ? AND key = ?",
      )
      .get(projectId, "DB_PASS");
    expect(row).toBeDefined();
    // ciphertext ต้องไม่ decode เป็น plaintext ตรง ๆ
    const hex = row!.value_ciphertext.toString("hex");
    expect(hex).not.toContain(Buffer.from("mysecretpassword123").toString("hex"));
    // ต้องยาวกว่า plaintext (header + ciphertext + GCM tag)
    expect(row!.value_ciphertext.length).toBeGreaterThan("mysecretpassword123".length);
  });

  test("PUT replace ทั้งหมด — ลบ key เก่า เพิ่ม key ใหม่", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    await put(app, projectId, cookie, csrf, [
      { key: "OLD", value: "old" },
      { key: "COMMON", value: "same" },
    ]);
    await put(app, projectId, cookie, csrf, [
      { key: "NEW", value: "new" },
      { key: "COMMON", value: "updated" },
    ]);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/environment`, {
        headers: { cookie },
      }),
    );
    const body = await json(res);
    const keys: string[] = body.variables.map((v: { key: string }) => v.key).sort();
    expect(keys).toEqual(["COMMON", "NEW"]);
    expect(keys).not.toContain("OLD");
  });

  test("PUT กับ list ว่าง → ลบทั้งหมด", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    await put(app, projectId, cookie, csrf, [{ key: "TEMP", value: "x" }]);
    await put(app, projectId, cookie, csrf, []);

    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/environment`, {
        headers: { cookie },
      }),
    );
    expect((await json(res)).variables).toHaveLength(0);
  });

  test("503 เมื่อไม่มี masterKeys", async () => {
    const { app, projectId, cookie, csrf } = await setup({ withKeys: false });
    const res = await put(app, projectId, cookie, csrf, [{ key: "X", value: "y" }]);
    expect(res.status).toBe(503);
    expect((await json(res)).error.code).toBe("ENV_ENCRYPTION_NOT_CONFIGURED");
  });

  test("409 เมื่อ key ซ้ำใน request", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await put(app, projectId, cookie, csrf, [
      { key: "DUPE", value: "a" },
      { key: "DUPE", value: "b" },
    ]);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("ENV_VAR_DUPLICATE_KEY");
  });

  test("422 เมื่อ key format ผิด", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await put(app, projectId, cookie, csrf, [{ key: "1INVALID", value: "bad" }]);
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe("ENV_VAR_INVALID_KEY");
  });

  test("AAD binding — ciphertext ของ project A ถอดรหัสด้วย AAD ของ project B ไม่ได้", async () => {
    const { app, db, projectId, cookie, csrf, masterKeys } = await setup();
    await put(app, projectId, cookie, csrf, [
      { key: "SECRET", value: "project-a-value", isSecret: true },
    ]);

    const rowA = db
      .query<{ value_ciphertext: Buffer }, [string, string]>(
        "SELECT value_ciphertext FROM environment_variables WHERE project_id = ? AND key = ?",
      )
      .get(projectId, "SECRET");

    // สร้าง project B แล้วยัด ciphertext ของ A ลงไป
    const now = Date.now();
    const projectB = ulid();
    db.query(
      `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
       VALUES (?, 'proj-b', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
    ).run(projectB, now, now);
    db.query(
      `INSERT INTO environment_variables
         (id, project_id, key, value_ciphertext, is_secret, scope, enabled, version, created_at, updated_at)
       VALUES (?, ?, 'SECRET', ?, 1, 'runtime', 1, 1, ?, ?)`,
    ).run(ulid(), projectB, rowA!.value_ciphertext, now, now);

    // decrypt ด้วย AAD ของ project B → ต้อง reject
    await expect(decryptEnvVarsForWorker(db, projectB, masterKeys!)).rejects.toThrow();
  });

  test("ต้อง CSRF → 403 ถ้าไม่ส่ง x-csrf-token", async () => {
    const { app, projectId, cookie } = await setup();
    const res = await app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/environment`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ variables: [] }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /projects/:id/environment/import
// ---------------------------------------------------------------------------

describe("POST /projects/:id/environment/import", () => {
  function importEnv(
    app: ReturnType<typeof buildApp>,
    projectId: string,
    cookie: string,
    csrf: string,
    content: string,
  ) {
    return app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/environment/import`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({ content }),
      }),
    );
  }

  test("parse .env content คืน parsed list", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await importEnv(app, projectId, cookie, csrf, '# comment\nFOO=bar\nBAZ="hi world"');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.parsed).toHaveLength(2);
    expect(body.parsed[0]).toMatchObject({ key: "FOO", value: "bar" });
    expect(body.parsed[1]).toMatchObject({ key: "BAZ", value: "hi world" });
    expect(body.warnings).toHaveLength(0);
  });

  test("import ไม่แตะ DB", async () => {
    const { app, db, projectId, cookie, csrf } = await setup();
    const before = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) as n FROM environment_variables WHERE project_id = ?",
      )
      .get(projectId)!.n;

    await importEnv(app, projectId, cookie, csrf, "IMPORT_ONLY=value");

    const after = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) as n FROM environment_variables WHERE project_id = ?",
      )
      .get(projectId)!.n;
    expect(after).toBe(before);
  });

  test("import ทำงานได้แม้ไม่มี masterKeys", async () => {
    const { app, projectId, cookie, csrf } = await setup({ withKeys: false });
    const res = await importEnv(app, projectId, cookie, csrf, "X=1");
    expect(res.status).toBe(200);
  });

  test("warnings สำหรับ key ซ้ำ", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await importEnv(app, projectId, cookie, csrf, "DUP=a\nDUP=b");
    const body = await json(res);
    expect(body.warnings.length).toBeGreaterThan(0);
    expect(body.parsed).toHaveLength(1);
    expect(body.parsed[0].value).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// POST /projects/:id/environment/validate
// ---------------------------------------------------------------------------

describe("POST /projects/:id/environment/validate", () => {
  function validate(
    app: ReturnType<typeof buildApp>,
    projectId: string,
    cookie: string,
    csrf: string,
    variables: Array<{ key: string }>,
  ) {
    return app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/environment/validate`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({ variables }),
      }),
    );
  }

  test("valid keys → valid=true, errors=[]", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await validate(app, projectId, cookie, csrf, [
      { key: "VALID_KEY" },
      { key: "_UNDERSCORE" },
      { key: "KEY123" },
    ]);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.valid).toBe(true);
    expect(body.errors).toHaveLength(0);
  });

  test("invalid key → valid=false + error entry", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await validate(app, projectId, cookie, csrf, [{ key: "1BAD" }, { key: "GOOD" }]);
    const body = await json(res);
    expect(body.valid).toBe(false);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].key).toBe("1BAD");
  });

  test("duplicate key → error entry", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await validate(app, projectId, cookie, csrf, [{ key: "DUPE" }, { key: "DUPE" }]);
    const body = await json(res);
    expect(body.valid).toBe(false);
    expect(body.errors[0].key).toBe("DUPE");
  });

  test("validate ทำงานได้แม้ไม่มี masterKeys", async () => {
    const { app, projectId, cookie, csrf } = await setup({ withKeys: false });
    const res = await validate(app, projectId, cookie, csrf, [{ key: "OK" }]);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Component-scoped env (Phase 18 · F)
// ---------------------------------------------------------------------------

describe("component-scoped environment (?componentId)", () => {
  function insertComp(db: ReturnType<typeof openDatabase>, projectId: string, name: string) {
    const id = ulid();
    const now = Date.now();
    db.query(
      `INSERT INTO project_components (id, project_id, name, source_kind, created_at, updated_at)
       VALUES (?, ?, ?, 'build', ?, ?)`,
    ).run(id, projectId, name, now, now);
    return id;
  }

  function putScoped(
    app: ReturnType<typeof buildApp>,
    projectId: string,
    cookie: string,
    csrf: string,
    variables: unknown[],
    componentId?: string,
  ) {
    const q = componentId ? `?componentId=${componentId}` : "";
    return app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/environment${q}`, {
        method: "PUT",
        headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
        body: JSON.stringify({ variables }),
      }),
    );
  }

  function getScoped(
    app: ReturnType<typeof buildApp>,
    projectId: string,
    cookie: string,
    componentId?: string,
  ) {
    const q = componentId ? `?componentId=${componentId}` : "";
    return app.handle(
      new Request(`http://localhost/api/v1/projects/${projectId}/environment${q}`, {
        headers: { cookie },
      }),
    );
  }

  test("PUT/GET scoped แยกจาก project-wide — ไม่ปนกัน", async () => {
    const { app, db, projectId, cookie, csrf } = await setup();
    const web = insertComp(db, projectId, "web");

    await putScoped(app, projectId, cookie, csrf, [{ key: "SHARED", value: "proj" }]); // project-wide
    await putScoped(app, projectId, cookie, csrf, [{ key: "ONLY_WEB", value: "w" }], web); // scoped

    // GET project-wide → เห็นแค่ SHARED
    const pw = await json(await getScoped(app, projectId, cookie));
    expect(pw.variables.map((v: { key: string }) => v.key)).toEqual(["SHARED"]);

    // GET scoped → เห็นแค่ ONLY_WEB + componentId ตรง
    const sc = await json(await getScoped(app, projectId, cookie, web));
    expect(sc.variables.map((v: { key: string }) => v.key)).toEqual(["ONLY_WEB"]);
    expect(sc.variables[0].componentId).toBe(web);
  });

  test("key เดียวกันอยู่ได้ทั้ง project-wide และ component (ไม่ชน UNIQUE)", async () => {
    const { app, db, projectId, cookie, csrf } = await setup();
    const web = insertComp(db, projectId, "web");
    const r1 = await putScoped(app, projectId, cookie, csrf, [{ key: "PORT", value: "3000" }]);
    const r2 = await putScoped(app, projectId, cookie, csrf, [{ key: "PORT", value: "4000" }], web);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  test("componentId ที่ไม่อยู่ในโปรเจกต์ → 404", async () => {
    const { app, projectId, cookie, csrf } = await setup();
    const res = await putScoped(app, projectId, cookie, csrf, [{ key: "X", value: "y" }], ulid());
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("COMPONENT_NOT_FOUND");
  });
});
