/**
 * injectEnvVars — unit tests (docs/phase-04-environment.md M3)
 *
 * ครอบคลุม:
 * - masterKeys null → empty injection (graceful)
 * - ไม่มีแถว / enabled=0 → empty
 * - scope runtime → runtimeEnv เท่านั้น
 * - scope build, non-secret → buildArgs เท่านั้น
 * - scope build, secret → buildSecretValues + secretValues (ห้ามไปอยู่ใน buildArgs)
 * - scope both, non-secret → runtimeEnv + buildArgs
 * - scope both, secret → runtimeEnv + buildSecretValues + secretValues
 * - secretValues รวมค่า is_secret=true ทุก scope
 * - decrypt ล้มเหลว → skip + log (ไม่ throw)
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { injectComponentEnv, injectEnvVars } from "../src/env/inject";
import { encryptEnvelope } from "../src/github/envelope";
import { createMasterKeys } from "../src/github/master-key";

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

async function makeKeys() {
  return createMasterKeys(1, { 1: new Uint8Array(32).fill(0x42) });
}

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function insertProject(db: ReturnType<typeof makeDb>): string {
  const projectId = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO projects
      (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'test', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(projectId, now, now);
  return projectId;
}

function insertComponent(db: ReturnType<typeof makeDb>, projectId: string, name: string): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO project_components (id, project_id, name, source_kind, created_at, updated_at)
     VALUES (?, ?, ?, 'build', ?, ?)`,
  ).run(id, projectId, name, now, now);
  return id;
}

async function insertEnvVar(
  db: ReturnType<typeof makeDb>,
  masterKeys: Awaited<ReturnType<typeof makeKeys>>,
  projectId: string,
  opts: {
    key: string;
    value: string;
    isSecret?: boolean;
    scope?: "runtime" | "build" | "both";
    enabled?: boolean;
    componentId?: string | null;
  },
) {
  const {
    key,
    value,
    isSecret = false,
    scope = "runtime",
    enabled = true,
    componentId = null,
  } = opts;
  const aad = `env:${projectId}:${key}`;
  const ciphertext = await encryptEnvelope(masterKeys, value, aad);
  const now = Date.now();
  db.query(
    `INSERT INTO environment_variables
      (id, project_id, key, value_ciphertext, is_secret, scope, enabled, version, created_at, updated_at, component_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    ulid(),
    projectId,
    key,
    ciphertext,
    isSecret ? 1 : 0,
    scope,
    enabled ? 1 : 0,
    now,
    now,
    componentId,
  );
}

function noLog(_: string) {}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("injectEnvVars — masterKeys null", () => {
  test("คืน empty injection โดยไม่ throw", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const result = await injectEnvVars(db, null, projectId, noLog);
    expect(result.runtimeEnv).toEqual({});
    expect(result.buildArgs).toEqual({});
    expect(result.buildSecretValues).toEqual([]);
    expect(result.secretValues).toEqual([]);
    expect(result.definedCount).toBe(0);
    expect(result.failedKeys).toEqual([]);
  });

  test("มี env ตั้งไว้แต่ไม่มี key → รายงาน failedKeys ครบทุกตัว + log warning (fail-loud accounting)", async () => {
    const db = makeDb();
    const keys = await makeKeys();
    const projectId = insertProject(db);
    await insertEnvVar(db, keys, projectId, { key: "DB_HOST", value: "h" });
    await insertEnvVar(db, keys, projectId, { key: "DB_PASSWORD", value: "p", isSecret: true });

    const logged: string[] = [];
    const result = await injectEnvVars(db, null, projectId, (line) => logged.push(line));

    expect(result.runtimeEnv).toEqual({});
    expect(result.definedCount).toBe(2);
    expect(result.failedKeys.sort()).toEqual(["DB_HOST", "DB_PASSWORD"]);
    expect(logged.some((l) => l.includes("master key"))).toBe(true);
  });
});

describe("injectEnvVars — ไม่มีแถว / enabled=0", () => {
  test("ไม่มีแถว → empty", async () => {
    const db = makeDb();
    const keys = await makeKeys();
    const projectId = insertProject(db);
    const result = await injectEnvVars(db, keys, projectId, noLog);
    expect(result.runtimeEnv).toEqual({});
    expect(result.buildArgs).toEqual({});
    expect(result.buildSecretValues).toEqual([]);
  });

  test("enabled=0 → ไม่รวม", async () => {
    const db = makeDb();
    const keys = await makeKeys();
    const projectId = insertProject(db);
    await insertEnvVar(db, keys, projectId, { key: "DISABLED", value: "skip", enabled: false });
    const result = await injectEnvVars(db, keys, projectId, noLog);
    expect(result.runtimeEnv).toEqual({});
    expect(result.buildArgs).toEqual({});
  });
});

describe("injectEnvVars — scope runtime", () => {
  test("non-secret runtime → runtimeEnv เท่านั้น", async () => {
    const db = makeDb();
    const keys = await makeKeys();
    const projectId = insertProject(db);
    await insertEnvVar(db, keys, projectId, { key: "PORT", value: "3000", scope: "runtime" });
    const result = await injectEnvVars(db, keys, projectId, noLog);
    expect(result.runtimeEnv).toEqual({ PORT: "3000" });
    expect(result.buildArgs).toEqual({});
    expect(result.buildSecretValues).toEqual([]);
  });

  test("secret runtime → runtimeEnv + secretValues (ไม่อยู่ใน buildArgs/buildSecretValues)", async () => {
    const db = makeDb();
    const keys = await makeKeys();
    const projectId = insertProject(db);
    await insertEnvVar(db, keys, projectId, {
      key: "DB_PASS",
      value: "s3cret",
      isSecret: true,
      scope: "runtime",
    });
    const result = await injectEnvVars(db, keys, projectId, noLog);
    expect(result.runtimeEnv).toEqual({ DB_PASS: "s3cret" });
    expect(result.buildArgs).toEqual({});
    expect(result.buildSecretValues).toEqual([]);
    expect(result.secretValues).toContain("s3cret");
  });
});

describe("injectEnvVars — scope build", () => {
  test("non-secret build → buildArgs เท่านั้น", async () => {
    const db = makeDb();
    const keys = await makeKeys();
    const projectId = insertProject(db);
    await insertEnvVar(db, keys, projectId, {
      key: "NODE_ENV",
      value: "production",
      scope: "build",
    });
    const result = await injectEnvVars(db, keys, projectId, noLog);
    expect(result.runtimeEnv).toEqual({});
    expect(result.buildArgs).toEqual({ NODE_ENV: "production" });
    expect(result.buildSecretValues).toEqual([]);
  });

  test("secret build → buildSecretValues + secretValues (ห้ามไปอยู่ใน buildArgs)", async () => {
    const db = makeDb();
    const keys = await makeKeys();
    const projectId = insertProject(db);
    await insertEnvVar(db, keys, projectId, {
      key: "NPM_TOKEN",
      value: "npm-secret-abc",
      isSecret: true,
      scope: "build",
    });
    const result = await injectEnvVars(db, keys, projectId, noLog);
    expect(result.runtimeEnv).toEqual({});
    expect(result.buildArgs).toEqual({});
    expect(result.buildSecretValues).toHaveLength(1);
    expect(result.buildSecretValues[0]).toEqual({ key: "NPM_TOKEN", value: "npm-secret-abc" });
    expect(result.secretValues).toContain("npm-secret-abc");
  });
});

describe("injectEnvVars — scope both", () => {
  test("non-secret both → runtimeEnv + buildArgs", async () => {
    const db = makeDb();
    const keys = await makeKeys();
    const projectId = insertProject(db);
    await insertEnvVar(db, keys, projectId, {
      key: "APP_ENV",
      value: "prod",
      scope: "both",
    });
    const result = await injectEnvVars(db, keys, projectId, noLog);
    expect(result.runtimeEnv).toEqual({ APP_ENV: "prod" });
    expect(result.buildArgs).toEqual({ APP_ENV: "prod" });
    expect(result.buildSecretValues).toEqual([]);
    expect(result.secretValues).toEqual([]);
  });

  test("secret both → runtimeEnv + buildSecretValues + secretValues (ไม่ใน buildArgs)", async () => {
    const db = makeDb();
    const keys = await makeKeys();
    const projectId = insertProject(db);
    await insertEnvVar(db, keys, projectId, {
      key: "REGISTRY_TOKEN",
      value: "tok-xyz",
      isSecret: true,
      scope: "both",
    });
    const result = await injectEnvVars(db, keys, projectId, noLog);
    expect(result.runtimeEnv).toEqual({ REGISTRY_TOKEN: "tok-xyz" });
    expect(result.buildArgs).toEqual({});
    expect(result.buildSecretValues).toHaveLength(1);
    expect(result.buildSecretValues[0]).toEqual({ key: "REGISTRY_TOKEN", value: "tok-xyz" });
    expect(result.secretValues).toContain("tok-xyz");
  });
});

describe("injectEnvVars — secretValues ครอบคลุมทุก scope", () => {
  test("is_secret=true ทุก scope ต้องอยู่ใน secretValues", async () => {
    const db = makeDb();
    const keys = await makeKeys();
    const projectId = insertProject(db);
    await insertEnvVar(db, keys, projectId, {
      key: "A",
      value: "sec-runtime",
      isSecret: true,
      scope: "runtime",
    });
    await insertEnvVar(db, keys, projectId, {
      key: "B",
      value: "sec-build",
      isSecret: true,
      scope: "build",
    });
    await insertEnvVar(db, keys, projectId, {
      key: "C",
      value: "sec-both",
      isSecret: true,
      scope: "both",
    });
    await insertEnvVar(db, keys, projectId, {
      key: "D",
      value: "not-secret",
      isSecret: false,
      scope: "runtime",
    });
    const result = await injectEnvVars(db, keys, projectId, noLog);
    expect(result.secretValues.sort()).toEqual(["sec-both", "sec-build", "sec-runtime"]);
    expect(result.secretValues).not.toContain("not-secret");
  });
});

describe("component-scoped env (Phase F)", () => {
  test("injectEnvVars (project-wide) ไม่รวม env ของ component", async () => {
    const db = makeDb();
    const keys = await makeKeys();
    const projectId = insertProject(db);
    const compId = insertComponent(db, projectId, "web");
    await insertEnvVar(db, keys, projectId, { key: "SHARED", value: "proj" }); // project-wide
    await insertEnvVar(db, keys, projectId, {
      key: "ONLY_WEB",
      value: "web-val",
      componentId: compId,
    });

    const result = await injectEnvVars(db, keys, projectId, noLog);
    // เห็นเฉพาะ project-wide — env ของ component ไม่รั่วเข้า project-wide inject
    expect(result.runtimeEnv).toEqual({ SHARED: "proj" });
  });

  test("injectComponentEnv คืนเฉพาะ env ของ component นั้น (ไม่ปน component อื่น/project-wide)", async () => {
    const db = makeDb();
    const keys = await makeKeys();
    const projectId = insertProject(db);
    const web = insertComponent(db, projectId, "web");
    const worker = insertComponent(db, projectId, "worker");
    await insertEnvVar(db, keys, projectId, { key: "SHARED", value: "proj" }); // project-wide
    await insertEnvVar(db, keys, projectId, { key: "K", value: "web-val", componentId: web });
    await insertEnvVar(db, keys, projectId, { key: "K", value: "worker-val", componentId: worker });

    const webEnv = await injectComponentEnv(db, keys, projectId, web, noLog);
    const workerEnv = await injectComponentEnv(db, keys, projectId, worker, noLog);

    // key เดียวกัน "K" อยู่ได้ทั้งสอง component ด้วยค่าต่างกัน (partial unique index ยอมให้)
    expect(webEnv.runtimeEnv).toEqual({ K: "web-val" });
    expect(workerEnv.runtimeEnv).toEqual({ K: "worker-val" });
  });
});

describe("injectEnvVars — decrypt failure", () => {
  test("ciphertext เสียหาย → skip + log ไม่ throw, key อื่นยังทำงานได้", async () => {
    const db = makeDb();
    const keys = await makeKeys();
    const projectId = insertProject(db);

    // Insert ด้วย junk ciphertext (ไม่ใช่ envelope จริง) โดยตรงลง DB
    const now = Date.now();
    db.query(
      `INSERT INTO environment_variables
        (id, project_id, key, value_ciphertext, is_secret, scope, enabled, version, created_at, updated_at)
       VALUES (?, ?, 'BAD_KEY', X'010203040506070809101112131415161718192021222324252627', 0, 'runtime', 1, 1, ?, ?)`,
    ).run(ulid(), projectId, now, now);

    // key ที่ดีอีกตัว
    await insertEnvVar(db, keys, projectId, { key: "GOOD_KEY", value: "hello", scope: "runtime" });

    const logged: string[] = [];
    const result = await injectEnvVars(db, keys, projectId, (line) => logged.push(line));

    // BAD_KEY ถูก skip
    expect(result.runtimeEnv).toEqual({ GOOD_KEY: "hello" });
    // มีการ log warning
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/BAD_KEY/);
    // accounting สำหรับ fail-loud: definedCount นับครบ, failedKeys เฉพาะตัวเสีย
    expect(result.definedCount).toBe(2);
    expect(result.failedKeys).toEqual(["BAD_KEY"]);
  });

  test("all vars bad ciphertext → empty injection ไม่ throw", async () => {
    const db = makeDb();
    const keys = await makeKeys();
    const projectId = insertProject(db);
    const now = Date.now();
    db.query(
      `INSERT INTO environment_variables
        (id, project_id, key, value_ciphertext, is_secret, scope, enabled, version, created_at, updated_at)
       VALUES (?, ?, 'K1', X'0102030405', 0, 'runtime', 1, 1, ?, ?)`,
    ).run(ulid(), projectId, now, now);

    const result = await injectEnvVars(db, keys, projectId, noLog);
    expect(result.runtimeEnv).toEqual({});
    // ทุกตัวเสีย → failedKeys เท่ากับ definedCount (pipeline ใช้เงื่อนไขนี้ตัดสิน fail-loud)
    expect(result.definedCount).toBe(1);
    expect(result.failedKeys).toEqual(["K1"]);
  });
});

describe("injectEnvVars — หลาย key ผสม scope", () => {
  test("หลาย key ประกอบกัน — แยก scope/secret ถูกต้องทุกตัว", async () => {
    const db = makeDb();
    const keys = await makeKeys();
    const projectId = insertProject(db);

    await insertEnvVar(db, keys, projectId, { key: "HOST", value: "localhost", scope: "runtime" });
    await insertEnvVar(db, keys, projectId, {
      key: "API_KEY",
      value: "key-xyz",
      isSecret: true,
      scope: "runtime",
    });
    await insertEnvVar(db, keys, projectId, {
      key: "BUILD_FLAG",
      value: "true",
      scope: "build",
    });
    await insertEnvVar(db, keys, projectId, {
      key: "NPM_TOKEN",
      value: "npm-secret",
      isSecret: true,
      scope: "build",
    });
    await insertEnvVar(db, keys, projectId, {
      key: "COMMON",
      value: "shared",
      scope: "both",
    });

    const result = await injectEnvVars(db, keys, projectId, noLog);

    expect(result.runtimeEnv).toEqual({
      HOST: "localhost",
      API_KEY: "key-xyz",
      COMMON: "shared",
    });
    expect(result.buildArgs).toEqual({ BUILD_FLAG: "true", COMMON: "shared" });
    expect(result.buildSecretValues).toEqual([{ key: "NPM_TOKEN", value: "npm-secret" }]);
    expect(result.secretValues.sort()).toEqual(["key-xyz", "npm-secret"]);
  });
});
