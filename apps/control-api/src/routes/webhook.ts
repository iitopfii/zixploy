/**
 * Public webhook endpoint: POST /api/v1/github/webhooks
 *
 * Security requirements (docs/threat-model.md section 2):
 * 1. อ่าน raw body ก่อน parse JSON
 * 2. ตรวจ HMAC-SHA256 แบบ constant-time กับ raw body
 * 3. Atomic INSERT OR IGNORE ป้องกัน race condition ใน idempotency check
 * 4. Compare-and-set UPDATE เพื่อ claim processing lease
 * 5. ตอบ 200 เร็วหลัง persist; ประมวลผลใน scope เดิม (Phase 2 ไม่มี worker)
 * 6. ไม่ log raw body, commit message body, หรือ author email
 *
 * Webhook processing state machine (migration 0004):
 * received → processing (lease claimed) → processed
 *                                        ↘ failed (retry ได้ถ้า attempt_count < MAX)
 *
 * Phase 2 boundary: สร้าง deploy_intent สำหรับ push ที่ผ่านการตรวจสอบ
 * Phase 3 จะ pick up deploy_intents และสร้าง deploy_jobs
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, ulid } from "@zixploy/shared";
import { Elysia } from "elysia";
import type { GitHubAppRegistry } from "../github/registry";
import {
  type InstallationEventPayload,
  type InstallationRepositoriesEventPayload,
  type PushEventPayload,
  parsePushBranch,
  verifyWebhookSignature,
} from "../github/webhook";
import { log } from "../logger";

/** Max webhook payload ขนาด 10 MB — GitHub payloads มักไม่เกิน 1 MB */
const MAX_WEBHOOK_BYTES = 10 * 1024 * 1024;

/**
 * Max retry attempts ก่อน permanently fail
 * attempt 1 = first try, attempt 2 = first retry, attempt 3 = last retry
 */
const MAX_WEBHOOK_ATTEMPTS = 3;

/**
 * Processing lease duration (ms)
 * ถ้า handler ใช้เวลานานกว่านี้ → stale → eligible for recovery
 */
const PROCESSING_LEASE_MS = 30_000;

export function webhookRoutes(db: Database, registry: GitHubAppRegistry) {
  return new Elysia({ prefix: `${API_PREFIX}/github` }).post(
    "/webhooks/:appId",
    async ({ params, request, set }) => {
      // --- 1. อ่าน raw body ก่อน parse ---
      const contentLength = Number(request.headers.get("content-length") ?? 0);
      if (contentLength > MAX_WEBHOOK_BYTES) {
        set.status = 413;
        return { ok: false, reason: "payload ใหญ่เกิน" };
      }

      const rawBody = await request.text();
      if (rawBody.length > MAX_WEBHOOK_BYTES) {
        set.status = 413;
        return { ok: false, reason: "payload ใหญ่เกิน" };
      }

      // --- 2. ตรวจ signature ด้วย secret เฉพาะของ app นี้ ---
      const signature = request.headers.get("x-hub-signature-256");
      const deliveryId = request.headers.get("x-github-delivery");
      const eventName = request.headers.get("x-github-event");

      // แต่ละ app มี webhook secret ของตัวเอง (decrypt จาก DB)
      let webhookSecret: string | null;
      try {
        webhookSecret = await registry.getWebhookSecret(params.appId);
      } catch (err) {
        log.error("webhook secret decrypt failed", {
          appRowId: params.appId,
          reason: err instanceof Error ? err.message : String(err),
        });
        set.status = 503;
        return { ok: false, reason: "webhook secret ไม่พร้อมใช้งาน" };
      }

      if (!webhookSecret) {
        // ไม่พบ app หรือ master key ไม่ได้ configure — reject ป้องกัน open webhook
        set.status = 404;
        return { ok: false, reason: "ไม่พบ GitHub App สำหรับ webhook นี้" };
      }

      const valid = await verifyWebhookSignature(rawBody, signature, webhookSecret);
      if (!valid) {
        set.status = 401;
        log.warn("webhook signature invalid", {
          eventName: eventName ?? "unknown",
          deliveryId: deliveryId ?? "unknown",
        });
        throw new AppError("WEBHOOK_SIGNATURE_INVALID", "Webhook signature ไม่ถูกต้อง");
      }

      if (!deliveryId || !eventName) {
        set.status = 400;
        return { ok: false, reason: "ขาด X-GitHub-Delivery หรือ X-GitHub-Event header" };
      }

      // --- 3. Parse JSON และ extract action (best effort ก่อน INSERT) ---
      // Parse ก่อน INSERT เพราะต้องการ action สำหรับ storage;
      // ผล parse เก็บไว้ตรวจซ้ำหลัง claim
      type ParseResult = { ok: true; value: unknown } | { ok: false };
      let parseResult: ParseResult = { ok: false };
      let action: string | null = null;
      try {
        const parsed = JSON.parse(rawBody);
        parseResult = { ok: true, value: parsed };
        if (typeof parsed === "object" && parsed !== null && "action" in parsed) {
          action = String((parsed as Record<string, unknown>).action);
        }
      } catch {
        // parseResult stays { ok: false } — handled after claim below
      }

      // --- 4. Atomic INSERT OR IGNORE — first request wins ---
      // ใช้ INSERT OR IGNORE แทน SELECT+INSERT เพื่อป้องกัน race condition
      // delivery_id เป็น PRIMARY KEY ดังนั้น SQLite enforce uniqueness atomically
      const receivedAt = Date.now();
      db.query(
        `INSERT OR IGNORE INTO webhook_deliveries
          (delivery_id, event, action, payload, status, attempt_count, received_at)
         VALUES (?, ?, ?, ?, 'received', 0, ?)`,
      ).run(deliveryId, eventName, action, rawBody, receivedAt);

      // --- 5. Claim processing lease (compare-and-set UPDATE) ---
      // อัปเดตสำเร็จ (changes > 0) = เราได้ lease นี้
      // อัปเดตไม่ได้ = มีคนอื่น claim ไปแล้ว หรือ delivery ถูก process แล้ว หรือ exhausted
      const now = Date.now();
      const staleThreshold = now - PROCESSING_LEASE_MS;
      const claimResult = db
        .query(
          `UPDATE webhook_deliveries
           SET status = 'processing', processing_started_at = ?, attempt_count = attempt_count + 1
           WHERE delivery_id = ?
             AND (
               status = 'received'
               OR (status = 'failed' AND attempt_count < ?)
               OR (status = 'processing' AND (processing_started_at IS NULL OR processing_started_at < ?))
             )`,
        )
        .run(now, deliveryId, MAX_WEBHOOK_ATTEMPTS, staleThreshold);

      if (claimResult.changes === 0) {
        // ไม่ได้ lease: duplicate, กำลัง process โดย request อื่น, หรือ exhausted
        const statusRow = db
          .query<{ status: string; attempt_count: number }, [string]>(
            "SELECT status, attempt_count FROM webhook_deliveries WHERE delivery_id = ?",
          )
          .get(deliveryId);

        if (statusRow?.status === "failed" && statusRow.attempt_count >= MAX_WEBHOOK_ATTEMPTS) {
          log.warn("webhook delivery exhausted max attempts — ไม่ retry อีก", {
            deliveryId,
            eventName,
            attempts: statusRow.attempt_count,
          });
        } else {
          log.info("webhook duplicate delivery", {
            deliveryId,
            eventName,
            status: statusRow?.status ?? "unknown",
          });
        }
        return { ok: true, duplicate: true };
      }

      // ได้ lease — อ่าน attempt_count ปัจจุบัน สำหรับ backoff calculation
      const claimedRow = db
        .query<{ attempt_count: number }, [string]>(
          "SELECT attempt_count FROM webhook_deliveries WHERE delivery_id = ?",
        )
        .get(deliveryId);
      const attemptCount = claimedRow?.attempt_count ?? 1;

      log.info("webhook delivery claimed", { deliveryId, eventName, attempt: attemptCount });

      // --- 6. ตรวจ JSON parse result (หลัง claim lease) ---
      // Invalid JSON = permanent failure — ไม่ retry เพราะ payload ไม่เปลี่ยน
      if (!parseResult.ok) {
        db.query(
          `UPDATE webhook_deliveries
           SET status = 'failed', last_error_code = 'INVALID_PAYLOAD', attempt_count = ?
           WHERE delivery_id = ?`,
        ).run(MAX_WEBHOOK_ATTEMPTS, deliveryId);
        set.status = 400;
        return { ok: false, reason: "invalid JSON" };
      }

      const payload = parseResult.value;

      // --- 7. Process event ---
      try {
        if (eventName === "push") {
          await handlePush(db, payload as PushEventPayload, deliveryId);
        } else if (eventName === "installation") {
          await handleInstallation(db, payload as InstallationEventPayload, registry, params.appId);
        } else if (eventName === "installation_repositories") {
          await handleInstallationRepositories(db, payload as InstallationRepositoriesEventPayload);
        }
        // events อื่น ignore อย่างปลอดภัย

        // mark processed — รักษา processed_at สำหรับ backward compat กับ Phase 3
        db.query(
          `UPDATE webhook_deliveries
           SET status = 'processed', processed_at = ?
           WHERE delivery_id = ?`,
        ).run(Date.now(), deliveryId);
      } catch (err) {
        const errorCode = err instanceof AppError ? err.code : "INTERNAL_ERROR";
        // Exponential backoff: 1h × 2^(attempt-1), cap ที่ 24h
        const backoffMs = Math.min(3_600_000 * 2 ** (attemptCount - 1), 86_400_000);

        db.query(
          `UPDATE webhook_deliveries
           SET status = 'failed', last_error_code = ?, next_retry_at = ?
           WHERE delivery_id = ?`,
        ).run(errorCode, Date.now() + backoffMs, deliveryId);

        log.error("webhook processing error", {
          deliveryId,
          eventName,
          errorCode,
          attempt: attemptCount,
          // ไม่ log err.message โดยตรงเพราะอาจมี sensitive data
        });
        // ยังตอบ 200 เพื่อไม่ให้ GitHub retry ทันที — redeliver ผ่าน UI ได้เมื่อพร้อม
      }

      return { ok: true };
    },
  );
}

/**
 * Handle push event — สร้าง deploy_intent ถ้าผ่านเงื่อนไขทั้งหมด
 * ใช้ INSERT OR IGNORE บน deploy_intents เพื่อ DB-level idempotency
 * (migration 0004 เพิ่ม UNIQUE INDEX บน project_id + delivery_id)
 */
async function handlePush(
  db: Database,
  payload: PushEventPayload,
  deliveryId: string,
): Promise<void> {
  // branch ถูกลบ → ไม่ deploy
  if (payload.deleted) return;

  const branch = parsePushBranch(payload.ref);
  if (!branch) return; // tags และ other refs → ignore

  const installationId = payload.installation?.id;
  if (!installationId) {
    log.warn("push event ไม่มี installation ID — ตรวจสอบ GitHub App permissions");
    return;
  }

  const repoId = payload.repository.id;
  const commitSha = payload.after;

  if (!commitSha || commitSha === "0000000000000000000000000000000000000000") {
    return; // force push ที่ลบ branch
  }

  // หา projects ที่ match installation + repo + branch + auto_deploy = 1
  interface ProjectRow {
    id: string;
  }

  const projects = db
    .query<ProjectRow, [number, number, string]>(
      `SELECT p.id
       FROM projects p
       JOIN github_installations gi ON p.installation_id = gi.id
       WHERE gi.installation_id = ?
         AND p.repo_id = ?
         AND p.branch = ?
         AND p.auto_deploy = 1
         AND p.archived_at IS NULL`,
    )
    .all(installationId, repoId, branch);

  if (projects.length === 0) return;

  const commitMessage = payload.head_commit?.message
    ? payload.head_commit.message.split("\n")[0]?.slice(0, 500)
    : null;

  // ไม่ log author email — แค่ display name
  const commitAuthor = payload.head_commit?.author?.name?.slice(0, 100) ?? null;

  const now = Date.now();
  for (const project of projects) {
    const intentId = ulid();
    // INSERT OR IGNORE — UNIQUE INDEX (project_id, delivery_id) ป้องกัน intent ซ้ำ
    // ถ้า delivery นี้เคย create intent ให้ project นี้แล้ว → silently ignore
    const intentResult = db
      .query(
        `INSERT OR IGNORE INTO deploy_intents
          (id, project_id, installation_id, repo_id, branch, commit_sha, commit_message, commit_author, delivery_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        intentId,
        project.id,
        installationId,
        repoId,
        branch,
        commitSha,
        commitMessage ?? null,
        commitAuthor,
        deliveryId,
        now,
        now,
      );

    if (intentResult.changes > 0) {
      log.info("deploy intent created", {
        intentId,
        projectId: project.id,
        branch,
        commitSha: commitSha.slice(0, 7), // short SHA สำหรับ log — ไม่ใช่ secret
      });
    }
  }
}

/**
 * Handle installation lifecycle events
 * appRowId = GitHub App ที่ส่ง webhook นี้มา (จาก URL path) — ผูก installation กับ app
 */
async function handleInstallation(
  db: Database,
  payload: InstallationEventPayload,
  registry: GitHubAppRegistry,
  appRowId: string,
): Promise<void> {
  const { action, installation } = payload;
  const { id: installationId } = installation;
  const now = Date.now();

  const row = db
    .query<{ id: string }, [number]>(
      "SELECT id FROM github_installations WHERE installation_id = ?",
    )
    .get(installationId);

  if (action === "deleted") {
    if (row) {
      db.query(
        "UPDATE github_installations SET status = 'deleted', updated_at = ? WHERE id = ?",
      ).run(now, row.id);
      // ปิด auto_deploy ของ projects ที่ใช้ installation นี้
      db.query("UPDATE projects SET auto_deploy = 0, updated_at = ? WHERE installation_id = ?").run(
        now,
        row.id,
      );
    }
    registry.invalidateToken(installationId);
    log.info("github installation deleted", { installationId });
  } else if (action === "suspend") {
    if (row) {
      db.query(
        "UPDATE github_installations SET status = 'suspended', updated_at = ? WHERE id = ?",
      ).run(now, row.id);
      db.query("UPDATE projects SET auto_deploy = 0, updated_at = ? WHERE installation_id = ?").run(
        now,
        row.id,
      );
    }
    registry.invalidateToken(installationId);
    log.info("github installation suspended", { installationId });
  } else if (action === "unsuspend") {
    if (row) {
      db.query(
        "UPDATE github_installations SET status = 'active', updated_at = ? WHERE id = ?",
      ).run(now, row.id);
    }
    log.info("github installation unsuspended", { installationId });
  } else if (action === "created" && !row) {
    // Installation ใหม่ผ่าน webhook (นอกจาก setup callback flow)
    const id = ulid();
    db.query(
      `INSERT INTO github_installations
        (id, installation_id, account_login, account_type, account_avatar_url, status, github_app_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', 'active', ?, ?, ?)`,
    ).run(
      id,
      installationId,
      installation.account.login,
      installation.account.type,
      appRowId,
      now,
      now,
    );
    log.info("github installation created via webhook", { installationId, appRowId });
  }
}

/** Handle repository access changes */
async function handleInstallationRepositories(
  db: Database,
  payload: InstallationRepositoriesEventPayload,
): Promise<void> {
  if (payload.action !== "removed") return;

  const removedIds = new Set((payload.repositories_removed ?? []).map((r) => r.id));
  if (removedIds.size === 0) return;

  const installRow = db
    .query<{ id: string }, [number]>(
      "SELECT id FROM github_installations WHERE installation_id = ?",
    )
    .get(payload.installation.id);

  if (!installRow) return;

  // ปิด auto_deploy สำหรับ projects ที่ repo ถูกถอนสิทธิ์
  const now = Date.now();
  for (const repoId of removedIds) {
    db.query(
      "UPDATE projects SET auto_deploy = 0, updated_at = ? WHERE installation_id = ? AND repo_id = ?",
    ).run(now, installRow.id, repoId);
  }

  log.info("repository access removed", {
    installationId: payload.installation.id,
    removedCount: removedIds.size,
  });
}
