import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { AppError, ulid } from "@zixploy/shared";
import { encryptEnvelope } from "../src/github/envelope";
import { createMasterKeys, type MasterKeys } from "../src/github/master-key";
import { mintInstallationToken, resetTokenCacheForTests } from "../src/github/token";

/** สร้าง RSA key pair สำหรับเทสต์ — ไม่ใช้ key จริง (เหมือน control-api/test/github-jwt.test.ts) */
async function generateTestKeyPair(): Promise<CryptoKey> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  return keyPair.privateKey;
}

async function exportPrivateKeyAsPem(key: CryptoKey): Promise<string> {
  const der = await crypto.subtle.exportKey("pkcs8", key);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

async function testMasterKeys(): Promise<MasterKeys> {
  return createMasterKeys(1, { 1: new Uint8Array(32).fill(0x42) });
}

async function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

async function seedGitHubApp(
  db: ReturnType<typeof openDatabase>,
  masterKeys: MasterKeys,
  opts: { appRowId?: string; numericAppId?: number } = {},
) {
  const appRowId = opts.appRowId ?? ulid();
  const now = Date.now();
  const privateKey = await generateTestKeyPair();
  const pem = await exportPrivateKeyAsPem(privateKey);
  const pemCiphertext = await encryptEnvelope(masterKeys, pem, `github_app:${appRowId}:pem`);

  db.query(
    `INSERT INTO github_apps
      (id, app_id, slug, name, html_url, owner_login, client_id,
       pem_ciphertext, webhook_secret_ciphertext, client_secret_ciphertext, created_at, updated_at)
     VALUES (?, ?, 'test-app', 'Test App', 'https://github.com/apps/test-app', 'test-org', 'Iv1.test',
             ?, ?, ?, ?, ?)`,
  ).run(
    appRowId,
    opts.numericAppId ?? 123456,
    pemCiphertext,
    new Uint8Array([1]),
    new Uint8Array([1]),
    now,
    now,
  );
  return appRowId;
}

function seedInstallation(
  db: ReturnType<typeof openDatabase>,
  installationId: number,
  appRowId: string,
) {
  const now = Date.now();
  db.query(
    `INSERT INTO github_installations
      (id, installation_id, account_login, account_type, account_avatar_url, status, github_app_id, created_at, updated_at)
     VALUES (?, ?, 'test-org', 'Organization', '', 'active', ?, ?, ?)`,
  ).run(ulid(), installationId, appRowId, now, now);
}

function mockFetch(response: { token: string; expires_at: string } | { status: number }) {
  let capturedUrl = "";
  let capturedAuth = "";
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedAuth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
    if ("status" in response) {
      return new Response(null, { status: response.status });
    }
    return new Response(JSON.stringify(response), { status: 201 });
  }) as unknown as typeof fetch;
  return { fn, getCapturedUrl: () => capturedUrl, getCapturedAuth: () => capturedAuth };
}

describe("mintInstallationToken", () => {
  test("mint สำเร็จ — ยิง JWT ที่ถูก sign ไปที่ access_tokens endpoint", async () => {
    resetTokenCacheForTests();
    const db = await makeDb();
    const masterKeys = await testMasterKeys();
    const appRowId = await seedGitHubApp(db, masterKeys);
    seedInstallation(db, 11111, appRowId);

    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const { fn, getCapturedUrl, getCapturedAuth } = mockFetch({
      token: "ghs_testtoken123",
      expires_at: expiresAt,
    });

    const result = await mintInstallationToken(db, masterKeys, 11111, fn);
    expect(result.token).toBe("ghs_testtoken123");
    expect(result.expiresAt.toISOString()).toBe(expiresAt);
    expect(getCapturedUrl()).toContain("/app/installations/11111/access_tokens");
    expect(getCapturedAuth()).toMatch(/^Bearer eyJ/); // JWT header ขึ้นต้นด้วย eyJ เสมอ
  });

  test("cache hit — ไม่เรียก fetch ซ้ำครั้งที่สอง", async () => {
    resetTokenCacheForTests();
    const db = await makeDb();
    const masterKeys = await testMasterKeys();
    const appRowId = await seedGitHubApp(db, masterKeys);
    seedInstallation(db, 22222, appRowId);

    let fetchCount = 0;
    const fn = (async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({
          token: "ghs_cached",
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;

    const first = await mintInstallationToken(db, masterKeys, 22222, fn);
    const second = await mintInstallationToken(db, masterKeys, 22222, fn);

    expect(first.token).toBe("ghs_cached");
    expect(second.token).toBe("ghs_cached");
    expect(fetchCount).toBe(1);
  });

  test("ไม่พบ installation ใน DB → AppError INSTALLATION_NOT_FOUND", async () => {
    resetTokenCacheForTests();
    const db = await makeDb();
    const masterKeys = await testMasterKeys();

    let caught: unknown;
    try {
      await mintInstallationToken(
        db,
        masterKeys,
        99999,
        (async () => new Response(null)) as unknown as typeof fetch,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("INSTALLATION_NOT_FOUND");
  });

  test("master key เป็น null → AppError GITHUB_UNAVAILABLE", async () => {
    resetTokenCacheForTests();
    const db = await makeDb();

    let caught: unknown;
    try {
      await mintInstallationToken(
        db,
        null,
        11111,
        (async () => new Response(null)) as unknown as typeof fetch,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("GITHUB_UNAVAILABLE");
  });

  test("GitHub ตอบ 404 → AppError INSTALLATION_NOT_FOUND", async () => {
    resetTokenCacheForTests();
    const db = await makeDb();
    const masterKeys = await testMasterKeys();
    const appRowId = await seedGitHubApp(db, masterKeys);
    seedInstallation(db, 33333, appRowId);

    const { fn } = mockFetch({ status: 404 });
    let caught: unknown;
    try {
      await mintInstallationToken(db, masterKeys, 33333, fn);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("INSTALLATION_NOT_FOUND");
  });

  test("GitHub ตอบ response ขาด field → AppError GITHUB_UNAVAILABLE", async () => {
    resetTokenCacheForTests();
    const db = await makeDb();
    const masterKeys = await testMasterKeys();
    const appRowId = await seedGitHubApp(db, masterKeys);
    seedInstallation(db, 44444, appRowId);

    const fn = (async () =>
      new Response(JSON.stringify({ expires_at: "2099-01-01T00:00:00Z" }), {
        status: 201,
      })) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await mintInstallationToken(db, masterKeys, 44444, fn);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("GITHUB_UNAVAILABLE");
  });

  test("สอง installation คนละ app — mint ได้อิสระจากกัน", async () => {
    resetTokenCacheForTests();
    const db = await makeDb();
    const masterKeys = await testMasterKeys();
    const appRow1 = await seedGitHubApp(db, masterKeys, { numericAppId: 111 });
    const appRow2 = await seedGitHubApp(db, masterKeys, { numericAppId: 222 });
    seedInstallation(db, 55555, appRow1);
    seedInstallation(db, 66666, appRow2);

    const { fn: fn1 } = mockFetch({
      token: "ghs_first",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    const { fn: fn2 } = mockFetch({
      token: "ghs_second",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });

    const first = await mintInstallationToken(db, masterKeys, 55555, fn1);
    const second = await mintInstallationToken(db, masterKeys, 66666, fn2);

    expect(first.token).toBe("ghs_first");
    expect(second.token).toBe("ghs_second");
  });
});
