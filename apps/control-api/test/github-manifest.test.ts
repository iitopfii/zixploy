/**
 * GitHub App Manifest flow tests
 *
 * ตรวจสอบ:
 * - Manifest JSON มี webhook/setup/redirect URL ถูกต้อง + permissions ขั้นต่ำ
 * - Action URL แยก personal vs organization
 * - Manifest code exchange: success, expired code (404), malformed response
 * - Registry: encrypt credentials ลง DB, state one-time use, service caching
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { AppError } from "@zixploy/shared";
import { decryptEnvelope } from "../src/crypto/envelope";
import { createMasterKeys } from "../src/crypto/master-key";
import { buildManifestForm, exchangeManifestCode } from "../src/github/manifest";
import { RealGitHubAppRegistry } from "../src/github/registry";

const BASE_URL = "https://zixploy.example.com";

async function testKeys() {
  return createMasterKeys(1, { 1: new Uint8Array(32).fill(0x42) });
}

/** Response ที่ GitHub คืนจาก manifest conversion */
function conversionResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 987654,
    slug: "my-zixploy",
    name: "My Zixploy",
    html_url: "https://github.com/apps/my-zixploy",
    owner: { login: "test-org" },
    client_id: "Iv1.abc123",
    client_secret: "secret-client-value",
    webhook_secret: "secret-webhook-value",
    pem: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
    ...overrides,
  };
}

// === buildManifestForm ===

describe("buildManifestForm", () => {
  const opts = {
    appName: "My Zixploy",
    baseUrl: BASE_URL,
    rowId: "01JBQZX0000000000000000000",
    state: "state-token",
  };

  test("webhook URL ฝัง rowId — แต่ละ app มี endpoint ของตัวเอง", () => {
    const form = buildManifestForm(opts);
    const manifest = JSON.parse(form.manifest) as {
      hook_attributes: { url: string; active: boolean };
    };
    expect(manifest.hook_attributes.url).toBe(
      `${BASE_URL}/api/v1/github/webhooks/01JBQZX0000000000000000000`,
    );
    expect(manifest.hook_attributes.active).toBe(true);
  });

  test("setup URL ฝัง rowId; redirect URL เป็น manifest callback", () => {
    const form = buildManifestForm(opts);
    const manifest = JSON.parse(form.manifest) as { setup_url: string; redirect_url: string };
    expect(manifest.setup_url).toBe(
      `${BASE_URL}/api/v1/github/apps/01JBQZX0000000000000000000/setup`,
    );
    expect(manifest.redirect_url).toBe(`${BASE_URL}/api/v1/github/apps/callback`);
  });

  test("permissions ขั้นต่ำ: contents+metadata read เท่านั้น", () => {
    const form = buildManifestForm(opts);
    const manifest = JSON.parse(form.manifest) as {
      default_permissions: Record<string, string>;
      default_events: string[];
    };
    expect(manifest.default_permissions).toEqual({ contents: "read", metadata: "read" });
    // ไม่มี write permission ใดๆ
    expect(Object.values(manifest.default_permissions)).not.toContain("write");
    expect(manifest.default_events).toContain("push");
  });

  test("app เป็น private (public: false)", () => {
    const form = buildManifestForm(opts);
    const manifest = JSON.parse(form.manifest) as { public: boolean };
    expect(manifest.public).toBe(false);
  });

  test("ไม่ระบุ organization → personal settings URL", () => {
    const form = buildManifestForm(opts);
    expect(form.action).toBe("https://github.com/settings/apps/new?state=state-token");
  });

  test("ระบุ organization → org settings URL พร้อม encode", () => {
    const form = buildManifestForm({ ...opts, organization: "my org" });
    expect(form.action).toContain("organizations/my%20org/settings/apps/new");
    expect(form.action).toContain("state=state-token");
  });

  test("state ถูก URL-encode ใน action", () => {
    const form = buildManifestForm({ ...opts, state: "a+b/c=d" });
    expect(form.action).toContain("state=a%2Bb%2Fc%3Dd");
  });
});

// === exchangeManifestCode ===

describe("exchangeManifestCode", () => {
  test("response ถูกต้อง → คืน credentials ครบ", async () => {
    const mockFetch = (async () =>
      new Response(JSON.stringify(conversionResponse()), {
        status: 201,
      })) as unknown as typeof fetch;

    const result = await exchangeManifestCode("code123", mockFetch);
    expect(result.appId).toBe(987654);
    expect(result.slug).toBe("my-zixploy");
    expect(result.ownerLogin).toBe("test-org");
    expect(result.clientId).toBe("Iv1.abc123");
    expect(result.pem).toContain("BEGIN RSA PRIVATE KEY");
    expect(result.webhookSecret).toBe("secret-webhook-value");
    expect(result.clientSecret).toBe("secret-client-value");
  });

  test("code ถูก URL-encode ใน path", async () => {
    let capturedUrl = "";
    const mockFetch = (async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify(conversionResponse()), { status: 201 });
    }) as unknown as typeof fetch;

    await exchangeManifestCode("code/with?special", mockFetch);
    expect(capturedUrl).toContain("code%2Fwith%3Fspecial");
    expect(capturedUrl).toContain("/app-manifests/");
  });

  test("owner ไม่มี → ownerLogin เป็น null", async () => {
    const mockFetch = (async () =>
      new Response(JSON.stringify(conversionResponse({ owner: null })), {
        status: 201,
      })) as unknown as typeof fetch;
    const result = await exchangeManifestCode("code", mockFetch);
    expect(result.ownerLogin).toBeNull();
  });

  test("404 (code หมดอายุ/ใช้แล้ว) → VALIDATION_ERROR", async () => {
    const mockFetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    await expect(exchangeManifestCode("expired", mockFetch)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  test("500 → GITHUB_UNAVAILABLE", async () => {
    const mockFetch = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    await expect(exchangeManifestCode("code", mockFetch)).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });

  test("response ไม่ใช่ JSON → GITHUB_UNAVAILABLE", async () => {
    const mockFetch = (async () =>
      new Response("not-json", { status: 201 })) as unknown as typeof fetch;
    await expect(exchangeManifestCode("code", mockFetch)).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });

  test("response ขาด field (pem) → GITHUB_UNAVAILABLE", async () => {
    const incomplete = conversionResponse();
    delete (incomplete as Record<string, unknown>).pem;
    const mockFetch = (async () =>
      new Response(JSON.stringify(incomplete), { status: 201 })) as unknown as typeof fetch;
    await expect(exchangeManifestCode("code", mockFetch)).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });

  test("network error → GITHUB_UNAVAILABLE", async () => {
    const mockFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(exchangeManifestCode("code", mockFetch)).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });

  test("timeout (AbortError) → GITHUB_UNAVAILABLE", async () => {
    const mockFetch = (async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    await expect(exchangeManifestCode("code", mockFetch)).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });
});

// === RealGitHubAppRegistry ===

function setupRegistry(masterKeys: Awaited<ReturnType<typeof testKeys>> | null) {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));

  const manifestFetch = (async () =>
    new Response(JSON.stringify(conversionResponse()), { status: 201 })) as unknown as typeof fetch;

  const registry = new RealGitHubAppRegistry(db, {
    baseUrl: BASE_URL,
    masterKeys,
    manifestFetch,
  });
  return { db, registry };
}

describe("RealGitHubAppRegistry — manifest lifecycle", () => {
  test("ไม่มี master key → isReady false, createManifest โยน GITHUB_UNAVAILABLE", async () => {
    const { registry } = setupRegistry(null);
    expect(registry.isReady()).toBe(false);
    expect(() => registry.createManifest("App")).toThrow(AppError);
  });

  test("มี master key → createManifest คืน form + state", async () => {
    const { registry } = setupRegistry(await testKeys());
    expect(registry.isReady()).toBe(true);
    const form = registry.createManifest("My App");
    expect(form.action).toContain("github.com/settings/apps/new");
    expect(typeof form.state).toBe("string");
    expect(form.state.length).toBeGreaterThan(10);
  });

  test("ชื่อ app ยาวเกิน 34 ตัวอักษร → VALIDATION_ERROR", async () => {
    const { registry } = setupRegistry(await testKeys());
    expect(() => registry.createManifest("x".repeat(35))).toThrow(AppError);
  });

  test("ชื่อ app ว่าง → VALIDATION_ERROR", async () => {
    const { registry } = setupRegistry(await testKeys());
    expect(() => registry.createManifest("   ")).toThrow(AppError);
  });

  test("completeManifest → app ถูกเก็บใน DB พร้อม credentials ที่ encrypted", async () => {
    const keys = await testKeys();
    const { db, registry } = setupRegistry(keys);

    const form = registry.createManifest("My App");
    const created = await registry.completeManifest("code123", form.state);

    expect(created.appId).toBe(987654);
    expect(created.slug).toBe("my-zixploy");

    // ตรวจว่า DB เก็บ ciphertext ไม่ใช่ plaintext
    const row = db
      .query<
        {
          id: string;
          pem_ciphertext: Uint8Array;
          webhook_secret_ciphertext: Uint8Array;
          client_secret_ciphertext: Uint8Array;
        },
        [string]
      >(
        "SELECT id, pem_ciphertext, webhook_secret_ciphertext, client_secret_ciphertext FROM github_apps WHERE id = ?",
      )
      .get(created.id)!;

    const pemBytes = Buffer.from(row.pem_ciphertext).toString("utf8");
    expect(pemBytes).not.toContain("BEGIN RSA PRIVATE KEY");
    const webhookBytes = Buffer.from(row.webhook_secret_ciphertext).toString("utf8");
    expect(webhookBytes).not.toContain("secret-webhook-value");

    // decrypt ด้วย AAD ที่ถูกต้องได้ค่าเดิม
    expect(
      await decryptEnvelope(keys, row.pem_ciphertext, `github_app:${created.id}:pem`),
    ).toContain("BEGIN RSA PRIVATE KEY");
    expect(
      await decryptEnvelope(
        keys,
        row.webhook_secret_ciphertext,
        `github_app:${created.id}:webhook_secret`,
      ),
    ).toBe("secret-webhook-value");
    expect(
      await decryptEnvelope(
        keys,
        row.client_secret_ciphertext,
        `github_app:${created.id}:client_secret`,
      ),
    ).toBe("secret-client-value");
  });

  test("state ใช้ได้ครั้งเดียว — ใช้ซ้ำ → VALIDATION_ERROR", async () => {
    const { registry } = setupRegistry(await testKeys());
    const form = registry.createManifest("My App");
    await registry.completeManifest("code123", form.state);
    await expect(registry.completeManifest("code456", form.state)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  test("state ที่ไม่เคยสร้าง → VALIDATION_ERROR", async () => {
    const { registry } = setupRegistry(await testKeys());
    await expect(registry.completeManifest("code", "never-issued")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  test("listApps/getApp คืน summary ที่ไม่มี secret ใดๆ", async () => {
    const { registry } = setupRegistry(await testKeys());
    const form = registry.createManifest("My App");
    const created = await registry.completeManifest("code", form.state);

    const apps = registry.listApps();
    expect(apps).toHaveLength(1);
    const serialized = JSON.stringify(apps[0]);
    expect(serialized).not.toContain("BEGIN RSA");
    expect(serialized).not.toContain("secret-client-value");
    expect(serialized).not.toContain("secret-webhook-value");

    expect(registry.getApp(created.id)?.slug).toBe("my-zixploy");
    expect(registry.getApp("nonexistent")).toBeNull();
  });

  test("getWebhookSecret → decrypt คืนค่าเดิม", async () => {
    const { registry } = setupRegistry(await testKeys());
    const form = registry.createManifest("My App");
    const created = await registry.completeManifest("code", form.state);

    expect(await registry.getWebhookSecret(created.id)).toBe("secret-webhook-value");
    expect(await registry.getWebhookSecret("nonexistent")).toBeNull();
  });

  test("getWebhookSecret ไม่มี master key → null (ไม่ throw)", async () => {
    const { registry } = setupRegistry(null);
    expect(await registry.getWebhookSecret("any-id")).toBeNull();
  });

  test("getInstallUrl ใช้ slug ของ app", async () => {
    const { registry } = setupRegistry(await testKeys());
    const form = registry.createManifest("My App");
    const created = await registry.completeManifest("code", form.state);

    expect(registry.getInstallUrl(created.id)).toBe(
      "https://github.com/apps/my-zixploy/installations/new",
    );
    expect(registry.getInstallUrl("nonexistent")).toBeNull();
  });
});

describe("RealGitHubAppRegistry — deleteApp", () => {
  test("ลบ app → installations ถูก mark deleted และ auto_deploy ปิด", async () => {
    const { db, registry } = setupRegistry(await testKeys());
    const form = registry.createManifest("My App");
    const created = await registry.completeManifest("code", form.state);

    // สร้าง installation + project ที่ใช้ app นี้
    const now = Date.now();
    const installDbId = "01JBQZINSTALL0000000000000";
    db.query(
      `INSERT INTO github_installations
        (id, installation_id, account_login, account_type, account_avatar_url, status, github_app_id, created_at, updated_at)
       VALUES (?, 55555, 'test-org', 'Organization', '', 'active', ?, ?, ?)`,
    ).run(installDbId, created.id, now, now);

    const projectId = "01JBQZPROJECT0000000000000";
    db.query(
      `INSERT INTO projects (id, name, status, installation_id, repo_id, repo_full_name, branch, auto_deploy, created_at, updated_at)
       VALUES (?, 'p', 'new', ?, 1, 'test-org/repo', 'main', 1, ?, ?)`,
    ).run(projectId, installDbId, now, now);

    registry.deleteApp(created.id);

    expect(registry.getApp(created.id)).toBeNull();

    const install = db
      .query<{ status: string; github_app_id: string | null }, [string]>(
        "SELECT status, github_app_id FROM github_installations WHERE id = ?",
      )
      .get(installDbId);
    expect(install?.status).toBe("deleted");
    expect(install?.github_app_id).toBeNull();

    const project = db
      .query<{ auto_deploy: number }, [string]>("SELECT auto_deploy FROM projects WHERE id = ?")
      .get(projectId);
    expect(project?.auto_deploy).toBe(0);
  });

  test("ลบ app ที่ไม่มีอยู่ → INSTALLATION_NOT_FOUND", async () => {
    const { registry } = setupRegistry(await testKeys());
    expect(() => registry.deleteApp("nonexistent")).toThrow(AppError);
  });
});
