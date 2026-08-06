import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { constantTimeEqual, parsePushBranch, verifyWebhookSignature } from "../src/github/webhook";
import { createMockRegistry, MOCK_APP_ID, signWebhook } from "./github-mock";

const WEBHOOK_SECRET = "test-webhook-secret-at-least-20-chars";
const WEBHOOK_PATH = `/api/v1/github/webhooks/${MOCK_APP_ID}`;

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

async function setup() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));

  const userId = ulid();
  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(userId, "admin", await hashPassword("correct horse battery staple"), now, now);

  insertApp(db);

  const registry = createMockRegistry({ defaultWebhookSecret: WEBHOOK_SECRET });
  const app = buildApp(db, { registry });
  return { db, app, userId, registry, mock: registry.service };
}

// Helper: สร้าง installation ใน DB
function insertInstallation(db: ReturnType<typeof openDatabase>, installationId: number) {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO github_installations
      (id, installation_id, account_login, account_type, account_avatar_url, status, github_app_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  ).run(
    id,
    installationId,
    "test-org",
    "Organization",
    "https://example.com/avatar.png",
    MOCK_APP_ID,
    now,
    now,
  );
  return id;
}

// Helper: สร้าง project พร้อม source
function insertProject(
  db: ReturnType<typeof openDatabase>,
  opts: {
    installationDbId: string;
    repoId: number;
    branch: string;
    autoDeploy?: boolean;
  },
) {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO projects (id, name, status, installation_id, repo_id, repo_full_name, branch, auto_deploy, created_at, updated_at)
     VALUES (?, ?, 'new', ?, ?, 'test-org/my-app', ?, ?, ?, ?)`,
  ).run(
    id,
    "test-project",
    opts.installationDbId,
    opts.repoId,
    opts.branch,
    opts.autoDeploy !== false ? 1 : 0,
    now,
    now,
  );
  return id;
}

// Helper: ส่ง webhook request
async function sendWebhook(
  app: ReturnType<typeof buildApp>,
  opts: {
    event: string;
    payload: object;
    secret?: string;
    deliveryId?: string;
    signature?: string | null;
  },
) {
  const body = JSON.stringify(opts.payload);
  const secret = opts.secret ?? WEBHOOK_SECRET;
  const deliveryId = opts.deliveryId ?? crypto.randomUUID();
  const signature = opts.signature !== undefined ? opts.signature : await signWebhook(body, secret);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": opts.event,
    "x-github-delivery": deliveryId,
    "x-hub-signature-256": signature ?? "",
  };
  if (opts.signature === null) delete headers["x-hub-signature-256"];

  return {
    deliveryId,
    response: await app.handle(
      new Request(`http://localhost${WEBHOOK_PATH}`, {
        method: "POST",
        headers,
        body,
      }),
    ),
  };
}

// === Signature verification tests ===
describe("webhook signature verification", () => {
  test("signature ถูกต้อง → true", async () => {
    const body = JSON.stringify({ test: true });
    const sig = await signWebhook(body, "mysecret");
    expect(await verifyWebhookSignature(body, sig, "mysecret")).toBe(true);
  });

  test("signature ผิด → false", async () => {
    const body = JSON.stringify({ test: true });
    expect(
      await verifyWebhookSignature(
        body,
        "sha256=deadbeef00000000000000000000000000000000000000000000000000000000",
        "mysecret",
      ),
    ).toBe(false);
  });

  test("signature null → false", async () => {
    expect(await verifyWebhookSignature("body", null, "mysecret")).toBe(false);
  });

  test("ไม่มี sha256= prefix → false", async () => {
    expect(await verifyWebhookSignature("body", "abcdef", "mysecret")).toBe(false);
  });

  test("body ต่างกัน → false", async () => {
    const sig = await signWebhook("original body", "mysecret");
    expect(await verifyWebhookSignature("tampered body", sig, "mysecret")).toBe(false);
  });

  test("secret ต่างกัน → false", async () => {
    const body = "payload";
    const sig = await signWebhook(body, "correct-secret");
    expect(await verifyWebhookSignature(body, sig, "wrong-secret")).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  test("strings เหมือนกัน → true", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });

  test("strings ต่างกัน → false", () => {
    expect(constantTimeEqual("abc", "xyz")).toBe(false);
  });

  test("ความยาวต่างกัน → false", () => {
    expect(constantTimeEqual("ab", "abc")).toBe(false);
  });

  test("string ว่าง → true", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("parsePushBranch", () => {
  test("refs/heads/main → main", () => {
    expect(parsePushBranch("refs/heads/main")).toBe("main");
  });

  test("refs/heads/feature/x → feature/x", () => {
    expect(parsePushBranch("refs/heads/feature/x")).toBe("feature/x");
  });

  test("refs/tags/v1.0 → null (ไม่ใช่ branch)", () => {
    expect(parsePushBranch("refs/tags/v1.0")).toBeNull();
  });

  test("refs/pull/1/merge → null", () => {
    expect(parsePushBranch("refs/pull/1/merge")).toBeNull();
  });
});

// === Webhook endpoint tests ===
describe("webhook endpoint — signature", () => {
  test("signature ถูกต้อง → 200", async () => {
    const { app } = await setup();
    const { response } = await sendWebhook(app, {
      event: "ping",
      payload: { zen: "Keep it logically awesome." },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Record<string, unknown>).ok).toBe(true);
  });

  test("signature ผิด → 401 WEBHOOK_SIGNATURE_INVALID", async () => {
    const { app } = await setup();
    const body = JSON.stringify({ test: true });
    const wrongSig = await signWebhook(body, "wrong-secret");
    const { response } = await sendWebhook(app, {
      event: "ping",
      payload: { test: true },
      signature: wrongSig,
    });
    expect(response.status).toBe(401);
    expect(((await response.json()) as Record<string, unknown>).error).toBeDefined();
  });

  test("ขาด signature header → 401", async () => {
    const { app } = await setup();
    const { response } = await sendWebhook(app, {
      event: "ping",
      payload: {},
      signature: null,
    });
    expect(response.status).toBe(401);
  });
});

describe("webhook endpoint — duplicate delivery", () => {
  test("ส่ง delivery ID เดิมครั้งที่สอง → 200 idempotent ไม่ error", async () => {
    const { app } = await setup();
    const payload = { test: true };
    const deliveryId = crypto.randomUUID();

    // ครั้งแรก
    const { response: first } = await sendWebhook(app, {
      event: "ping",
      payload,
      deliveryId,
    });
    expect(first.status).toBe(200);

    // ครั้งที่สอง (delivery ID เดิม)
    const { response: second } = await sendWebhook(app, {
      event: "ping",
      payload,
      deliveryId,
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody.ok).toBe(true);
    expect(secondBody.duplicate).toBe(true);
  });
});

describe("webhook endpoint — push event", () => {
  test("push ถูก branch + auto_deploy = 1 → สร้าง deploy_intent", async () => {
    const { app, db } = await setup();
    const installationId = 11111;
    const repoId = 55555;
    const installDbId = insertInstallation(db, installationId);
    insertProject(db, { installationDbId: installDbId, repoId, branch: "main", autoDeploy: true });

    const payload = {
      ref: "refs/heads/main",
      after: "a".repeat(40),
      deleted: false,
      installation: { id: installationId },
      repository: { id: repoId, full_name: "test-org/my-app" },
      head_commit: { message: "feat: add feature\n\ndetail", author: { name: "Dev" } },
    };

    const { response } = await sendWebhook(app, { event: "push", payload });
    expect(response.status).toBe(200);

    // ตรวจ deploy_intent ถูกสร้าง
    const intent = db.query("SELECT * FROM deploy_intents WHERE branch = 'main'").get() as Record<
      string,
      unknown
    > | null;
    expect(intent).not.toBeNull();
    expect(intent!.commit_sha).toBe("a".repeat(40));
    expect(intent!.commit_message).toBe("feat: add feature"); // แค่บรรทัดแรก
    expect(intent!.status).toBe("pending");
  });

  test("push ผิด branch → ไม่สร้าง deploy_intent", async () => {
    const { app, db } = await setup();
    const installationId = 22222;
    const repoId = 66666;
    const installDbId = insertInstallation(db, installationId);
    insertProject(db, { installationDbId: installDbId, repoId, branch: "main" });

    const payload = {
      ref: "refs/heads/develop", // project ใช้ main
      after: "b".repeat(40),
      deleted: false,
      installation: { id: installationId },
      repository: { id: repoId, full_name: "test-org/my-app" },
      head_commit: null,
    };

    const { response } = await sendWebhook(app, { event: "push", payload });
    expect(response.status).toBe(200);

    const count = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM deploy_intents").get()!.n;
    expect(count).toBe(0);
  });

  test("push auto_deploy = 0 → ไม่สร้าง deploy_intent", async () => {
    const { app, db } = await setup();
    const installationId = 33333;
    const repoId = 77777;
    const installDbId = insertInstallation(db, installationId);
    insertProject(db, { installationDbId: installDbId, repoId, branch: "main", autoDeploy: false });

    const payload = {
      ref: "refs/heads/main",
      after: "c".repeat(40),
      deleted: false,
      installation: { id: installationId },
      repository: { id: repoId, full_name: "test-org/my-app" },
      head_commit: { message: "chore: update", author: { name: "Dev" } },
    };

    const { response } = await sendWebhook(app, { event: "push", payload });
    expect(response.status).toBe(200);

    const count = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM deploy_intents").get()!.n;
    expect(count).toBe(0);
  });

  test("push ที่ลบ branch (deleted: true) → ไม่สร้าง deploy_intent", async () => {
    const { app, db } = await setup();
    const installationId = 44444;
    const repoId = 88888;
    const installDbId = insertInstallation(db, installationId);
    insertProject(db, { installationDbId: installDbId, repoId, branch: "feature/x" });

    const payload = {
      ref: "refs/heads/feature/x",
      after: "0".repeat(40),
      deleted: true, // branch ถูกลบ
      installation: { id: installationId },
      repository: { id: repoId, full_name: "test-org/my-app" },
      head_commit: null,
    };

    const { response } = await sendWebhook(app, { event: "push", payload });
    expect(response.status).toBe(200);

    const count = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM deploy_intents").get()!.n;
    expect(count).toBe(0);
  });

  test("push ไปยัง tag (refs/tags/) → ไม่สร้าง deploy_intent", async () => {
    const { app, db } = await setup();
    const { response } = await sendWebhook(app, {
      event: "push",
      payload: {
        ref: "refs/tags/v1.0.0",
        after: "d".repeat(40),
        deleted: false,
        installation: { id: 99999 },
        repository: { id: 11111, full_name: "any/repo" },
        head_commit: null,
      },
    });
    expect(response.status).toBe(200);
    const count = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM deploy_intents").get()!.n;
    expect(count).toBe(0);
  });

  test("push เดียว → สร้าง intent เพียง 1 ครั้ง (idempotency via delivery_id)", async () => {
    const { app, db } = await setup();
    const installationId = 55555;
    const repoId = 99999;
    const installDbId = insertInstallation(db, installationId);
    insertProject(db, { installationDbId: installDbId, repoId, branch: "main" });

    const deliveryId = crypto.randomUUID();
    const payload = {
      ref: "refs/heads/main",
      after: "e".repeat(40),
      deleted: false,
      installation: { id: installationId },
      repository: { id: repoId, full_name: "test-org/my-app" },
      head_commit: { message: "test", author: { name: "Dev" } },
    };

    // ส่ง 2 ครั้ง
    await sendWebhook(app, { event: "push", payload, deliveryId });
    await sendWebhook(app, { event: "push", payload, deliveryId }); // duplicate

    const count = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM deploy_intents").get()!.n;
    expect(count).toBe(1); // ไม่ซ้ำเพราะ delivery_id unique
  });
});

describe("webhook endpoint — installation events", () => {
  test("installation deleted → status เป็น deleted, auto_deploy projects ปิด", async () => {
    const { app, db } = await setup();
    const installationId = 66666;
    const installDbId = insertInstallation(db, installationId);
    const projectId = insertProject(db, {
      installationDbId: installDbId,
      repoId: 11111,
      branch: "main",
      autoDeploy: true,
    });

    const { response } = await sendWebhook(app, {
      event: "installation",
      payload: {
        action: "deleted",
        installation: { id: installationId, account: { login: "test-org", type: "Organization" } },
      },
    });
    expect(response.status).toBe(200);

    const install = db
      .query<{ status: string }, [string]>("SELECT status FROM github_installations WHERE id = ?")
      .get(installDbId);
    expect(install?.status).toBe("deleted");

    const project = db
      .query<{ auto_deploy: number }, [string]>("SELECT auto_deploy FROM projects WHERE id = ?")
      .get(projectId);
    expect(project?.auto_deploy).toBe(0);
  });

  test("installation suspend → status suspended, auto_deploy ปิด", async () => {
    const { app, db } = await setup();
    const installationId = 77777;
    const installDbId = insertInstallation(db, installationId);
    insertProject(db, {
      installationDbId: installDbId,
      repoId: 22222,
      branch: "main",
      autoDeploy: true,
    });

    await sendWebhook(app, {
      event: "installation",
      payload: {
        action: "suspend",
        installation: { id: installationId, account: { login: "test-org", type: "Organization" } },
      },
    });

    const install = db
      .query<{ status: string }, [string]>("SELECT status FROM github_installations WHERE id = ?")
      .get(installDbId);
    expect(install?.status).toBe("suspended");
  });

  test("installation unsuspend → status กลับเป็น active", async () => {
    const { app, db } = await setup();
    const installationId = 88888;
    const installDbId = insertInstallation(db, installationId);

    // suspend ก่อน
    db.query("UPDATE github_installations SET status = 'suspended' WHERE id = ?").run(installDbId);

    await sendWebhook(app, {
      event: "installation",
      payload: {
        action: "unsuspend",
        installation: { id: installationId, account: { login: "test-org", type: "Organization" } },
      },
    });

    const install = db
      .query<{ status: string }, [string]>("SELECT status FROM github_installations WHERE id = ?")
      .get(installDbId);
    expect(install?.status).toBe("active");
  });
});

describe("webhook endpoint — installation_repositories", () => {
  test("repositories removed → auto_deploy ปิดสำหรับ repo ที่ถูกถอน", async () => {
    const { app, db } = await setup();
    const installationId = 99999;
    const removedRepoId = 33333;
    const keptRepoId = 44444;
    const installDbId = insertInstallation(db, installationId);

    const removedProjectId = insertProject(db, {
      installationDbId: installDbId,
      repoId: removedRepoId,
      branch: "main",
      autoDeploy: true,
    });
    const keptProjectId = insertProject(db, {
      installationDbId: installDbId,
      repoId: keptRepoId,
      branch: "main",
      autoDeploy: true,
    });

    await sendWebhook(app, {
      event: "installation_repositories",
      payload: {
        action: "removed",
        installation: { id: installationId },
        repositories_removed: [{ id: removedRepoId, full_name: "test-org/removed-repo" }],
      },
    });

    const removed = db
      .query<{ auto_deploy: number }, [string]>("SELECT auto_deploy FROM projects WHERE id = ?")
      .get(removedProjectId);
    expect(removed?.auto_deploy).toBe(0);

    const kept = db
      .query<{ auto_deploy: number }, [string]>("SELECT auto_deploy FROM projects WHERE id = ?")
      .get(keptProjectId);
    expect(kept?.auto_deploy).toBe(1); // ไม่ได้รับผลกระทบ
  });
});

// === Webhook processing state machine tests (hardening migration 0004) ===

describe("webhook processing state machine — atomic idempotency", () => {
  test("INSERT OR IGNORE + compare-and-set: มีเพียง claim เดียว", async () => {
    // ทดสอบ DB-level claim mechanism โดยตรง — ไม่ผ่าน HTTP
    const { db } = await setup();
    const deliveryId = crypto.randomUUID();
    const now = Date.now();

    db.query(
      `INSERT INTO webhook_deliveries
        (delivery_id, event, action, payload, status, attempt_count, received_at)
       VALUES (?, 'ping', NULL, '{}', 'received', 0, ?)`,
    ).run(deliveryId, now);

    // ทำ claim 2 ครั้งติดกัน — SQLite sync ดังนั้นครั้งแรกชนะ
    const staleThreshold = now - 30_000;
    const claimSql = `UPDATE webhook_deliveries
     SET status = 'processing', processing_started_at = ?, attempt_count = attempt_count + 1
     WHERE delivery_id = ?
       AND (
         status = 'received'
         OR (status = 'failed' AND attempt_count < 3)
         OR (status = 'processing' AND (processing_started_at IS NULL OR processing_started_at < ?))
       )`;

    const r1 = db.query(claimSql).run(now, deliveryId, staleThreshold);
    const r2 = db.query(claimSql).run(now, deliveryId, staleThreshold);

    expect(r1.changes + r2.changes).toBe(1); // มีเพียง claim เดียวสำเร็จ

    const row = db
      .query<{ status: string; attempt_count: number }, [string]>(
        "SELECT status, attempt_count FROM webhook_deliveries WHERE delivery_id = ?",
      )
      .get(deliveryId);
    expect(row?.status).toBe("processing");
    expect(row?.attempt_count).toBe(1);
  });

  test("delivery processed แล้ว → ส่งซ้ำ → duplicate:true ไม่ re-process", async () => {
    const { app, db } = await setup();
    const deliveryId = crypto.randomUUID();
    const now = Date.now();

    // Insert delivery ที่ processed แล้ว
    db.query(
      `INSERT INTO webhook_deliveries
        (delivery_id, event, action, payload, status, attempt_count, received_at, processed_at)
       VALUES (?, 'ping', NULL, '{}', 'processed', 1, ?, ?)`,
    ).run(deliveryId, now, now);

    const { response } = await sendWebhook(app, {
      event: "ping",
      payload: {},
      deliveryId,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBe(true);

    // attempt_count ไม่เพิ่ม
    const row = db
      .query<{ attempt_count: number }, [string]>(
        "SELECT attempt_count FROM webhook_deliveries WHERE delivery_id = ?",
      )
      .get(deliveryId);
    expect(row?.attempt_count).toBe(1);
  });

  test("invalid JSON → 400, delivery marked failed + INVALID_PAYLOAD + attempt exhausted", async () => {
    const { app, db } = await setup();
    const deliveryId = crypto.randomUUID();

    // ส่ง body ที่ไม่ใช่ JSON แต่ signature ถูกต้อง
    const badBody = "not-valid-json!!!";
    const sig = await signWebhook(badBody, WEBHOOK_SECRET);

    const response = await app.handle(
      new Request(`http://localhost${WEBHOOK_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "x-github-event": "push",
          "x-github-delivery": deliveryId,
          "x-hub-signature-256": sig,
        },
        body: badBody,
      }),
    );
    expect(response.status).toBe(400);

    const row = db
      .query<{ status: string; last_error_code: string; attempt_count: number }, [string]>(
        "SELECT status, last_error_code, attempt_count FROM webhook_deliveries WHERE delivery_id = ?",
      )
      .get(deliveryId);
    expect(row?.status).toBe("failed");
    expect(row?.last_error_code).toBe("INVALID_PAYLOAD");
    expect(row?.attempt_count).toBe(3); // MAX_WEBHOOK_ATTEMPTS — ไม่ retry อีก
  });
});

describe("webhook processing state machine — retry recovery", () => {
  test("failed delivery (attempt_count < 3) → retry สำเร็จ → processed", async () => {
    const { app, db } = await setup();
    const installationId = 111111;
    const repoId = 222222;
    const installDbId = insertInstallation(db, installationId);
    insertProject(db, { installationDbId: installDbId, repoId, branch: "main" });

    const deliveryId = crypto.randomUUID();
    const pushPayload = {
      ref: "refs/heads/main",
      after: "f".repeat(40),
      deleted: false,
      installation: { id: installationId },
      repository: { id: repoId, full_name: "test-org/my-app" },
      head_commit: { message: "retry test", author: { name: "Dev" } },
    };

    // Pre-insert เป็น failed (attempt_count=1) — เหมือน handler ล้มครั้งแรก
    const now = Date.now();
    db.query(
      `INSERT INTO webhook_deliveries
        (delivery_id, event, action, payload, status, attempt_count, received_at, last_error_code)
       VALUES (?, 'push', NULL, ?, 'failed', 1, ?, 'INTERNAL_ERROR')`,
    ).run(deliveryId, JSON.stringify(pushPayload), now);

    // Redeliver (GitHub retry)
    const { response } = await sendWebhook(app, {
      event: "push",
      payload: pushPayload,
      deliveryId,
    });
    expect(response.status).toBe(200);

    const row = db
      .query<{ status: string; attempt_count: number }, [string]>(
        "SELECT status, attempt_count FROM webhook_deliveries WHERE delivery_id = ?",
      )
      .get(deliveryId);
    expect(row?.status).toBe("processed");
    expect(row?.attempt_count).toBe(2); // incremented by claim

    // ตรวจ deploy_intent ถูกสร้าง (retry สำเร็จ)
    const intentCount = db
      .query<{ n: number }, []>("SELECT COUNT(*) as n FROM deploy_intents")
      .get()!.n;
    expect(intentCount).toBe(1);
  });

  test("stale processing lease (>30s) → recovery claim สำเร็จ → processed", async () => {
    const { app, db } = await setup();
    const deliveryId = crypto.randomUUID();
    const staleStart = Date.now() - 60_000; // 60 วินาทีที่แล้ว = stale

    db.query(
      `INSERT INTO webhook_deliveries
        (delivery_id, event, action, payload, status, attempt_count, received_at, processing_started_at)
       VALUES (?, 'ping', NULL, '{}', 'processing', 1, ?, ?)`,
    ).run(deliveryId, staleStart, staleStart);

    // Redeliver: lease stale → claim ได้ → processed
    const { response } = await sendWebhook(app, {
      event: "ping",
      payload: {},
      deliveryId,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBeUndefined(); // ไม่ใช่ duplicate — ถูก process จริง

    const row = db
      .query<{ status: string; attempt_count: number }, [string]>(
        "SELECT status, attempt_count FROM webhook_deliveries WHERE delivery_id = ?",
      )
      .get(deliveryId);
    expect(row?.status).toBe("processed");
    expect(row?.attempt_count).toBe(2); // stale attempt (1) + recovery attempt (2)
  });

  test("exhausted delivery (attempt_count = 3) → ไม่ retry → duplicate:true", async () => {
    const { app, db } = await setup();
    const deliveryId = crypto.randomUUID();
    const now = Date.now();

    db.query(
      `INSERT INTO webhook_deliveries
        (delivery_id, event, action, payload, status, attempt_count, received_at, last_error_code)
       VALUES (?, 'push', NULL, '{}', 'failed', 3, ?, 'INTERNAL_ERROR')`,
    ).run(deliveryId, now);

    const { response } = await sendWebhook(app, {
      event: "push",
      payload: {},
      deliveryId,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.duplicate).toBe(true);

    // ยัง failed, attempt_count ไม่เพิ่ม
    const row = db
      .query<{ status: string; attempt_count: number }, [string]>(
        "SELECT status, attempt_count FROM webhook_deliveries WHERE delivery_id = ?",
      )
      .get(deliveryId);
    expect(row?.status).toBe("failed");
    expect(row?.attempt_count).toBe(3);
  });
});

describe("webhook processing state machine — deploy_intent idempotency", () => {
  test("UNIQUE INDEX (project_id, delivery_id): INSERT OR IGNORE ป้องกัน intent ซ้ำ", async () => {
    const { db } = await setup();
    const installationId = 333333;
    const repoId = 444444;
    const installDbId = insertInstallation(db, installationId);
    const projectId = insertProject(db, {
      installationDbId: installDbId,
      repoId,
      branch: "main",
    });
    const deliveryId = crypto.randomUUID();
    const now = Date.now();

    // FK: ต้อง insert webhook_deliveries ก่อน
    db.query(
      `INSERT INTO webhook_deliveries (delivery_id, event, action, payload, status, attempt_count, received_at)
       VALUES (?, 'push', NULL, '{}', 'processed', 1, ?)`,
    ).run(deliveryId, now);

    // Insert สำเร็จ
    const r1 = db
      .query(
        `INSERT OR IGNORE INTO deploy_intents
          (id, project_id, installation_id, repo_id, branch, commit_sha, delivery_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'main', ?, ?, 'pending', ?, ?)`,
      )
      .run(ulid(), projectId, installationId, repoId, "a".repeat(40), deliveryId, now, now);
    expect(r1.changes).toBe(1);

    // Insert ซ้ำ (project_id + delivery_id เดิม) → IGNORE
    const r2 = db
      .query(
        `INSERT OR IGNORE INTO deploy_intents
          (id, project_id, installation_id, repo_id, branch, commit_sha, delivery_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'main', ?, ?, 'pending', ?, ?)`,
      )
      .run(ulid(), projectId, installationId, repoId, "b".repeat(40), deliveryId, now, now);
    expect(r2.changes).toBe(0); // ไม่ insert

    const count = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM deploy_intents").get()!.n;
    expect(count).toBe(1); // intent เดียวเท่านั้น
  });

  test("intent คนละ delivery_id → สร้างได้ทั้งคู่", async () => {
    const { db } = await setup();
    const installationId = 555555;
    const repoId = 666666;
    const installDbId = insertInstallation(db, installationId);
    const projectId = insertProject(db, {
      installationDbId: installDbId,
      repoId,
      branch: "main",
    });
    const now = Date.now();
    const deliveryId1 = crypto.randomUUID();
    const deliveryId2 = crypto.randomUUID();

    // FK: insert webhook_deliveries ก่อน
    db.query(
      `INSERT INTO webhook_deliveries (delivery_id, event, action, payload, status, attempt_count, received_at)
       VALUES (?, 'push', NULL, '{}', 'processed', 1, ?)`,
    ).run(deliveryId1, now);
    db.query(
      `INSERT INTO webhook_deliveries (delivery_id, event, action, payload, status, attempt_count, received_at)
       VALUES (?, 'push', NULL, '{}', 'processed', 1, ?)`,
    ).run(deliveryId2, now);

    const r1 = db
      .query(
        `INSERT OR IGNORE INTO deploy_intents
          (id, project_id, installation_id, repo_id, branch, commit_sha, delivery_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'main', ?, ?, 'pending', ?, ?)`,
      )
      .run(ulid(), projectId, installationId, repoId, "a".repeat(40), deliveryId1, now, now);

    const r2 = db
      .query(
        `INSERT OR IGNORE INTO deploy_intents
          (id, project_id, installation_id, repo_id, branch, commit_sha, delivery_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'main', ?, ?, 'pending', ?, ?)`,
      )
      .run(ulid(), projectId, installationId, repoId, "b".repeat(40), deliveryId2, now, now);

    expect(r1.changes + r2.changes).toBe(2);
    const count = db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM deploy_intents").get()!.n;
    expect(count).toBe(2);
  });
});
