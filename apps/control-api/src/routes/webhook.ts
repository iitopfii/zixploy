/**
 * Public webhook endpoint: POST /api/v1/github/webhooks
 *
 * Security requirements (docs/threat-model.md section 2):
 * 1. อ่าน raw body ก่อน parse JSON
 * 2. ตรวจ HMAC-SHA256 แบบ constant-time กับ raw body
 * 3. เก็บ X-GitHub-Delivery ด้วย unique constraint (idempotency)
 * 4. ตอบ 200 เร็วหลัง persist; ประมวลผลใน scope เดิม (Phase 2 ไม่มี worker)
 * 5. ไม่ log raw body, commit message body, หรือ author email
 *
 * Phase 2 boundary: สร้าง deploy_intent สำหรับ push ที่ผ่านการตรวจสอบ
 * Phase 3 จะ pick up deploy_intents และสร้าง deploy_jobs
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, ulid } from "@zixploy/shared";
import { Elysia } from "elysia";
import type { GitHubService } from "../github/service";
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

export function webhookRoutes(db: Database, github: GitHubService | null, webhookSecret?: string) {
  return new Elysia({ prefix: `${API_PREFIX}/github` }).post(
    "/webhooks",
    async ({ request, set }) => {
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

      // --- 2. ตรวจ signature ---
      const signature = request.headers.get("x-hub-signature-256");
      const deliveryId = request.headers.get("x-github-delivery");
      const eventName = request.headers.get("x-github-event");

      if (!webhookSecret) {
        // ไม่ configure — reject ทั้งหมด ป้องกัน open webhook
        set.status = 503;
        return { ok: false, reason: "webhook ยังไม่ได้ configure" };
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

      // --- 3. Idempotency check ---
      const duplicate = db
        .query<{ delivery_id: string }, [string]>(
          "SELECT delivery_id FROM webhook_deliveries WHERE delivery_id = ?",
        )
        .get(deliveryId);

      if (duplicate) {
        // ตอบ 200 แบบ idempotent — ไม่ error เพราะ GitHub อาจ retry
        log.info("webhook duplicate delivery", { deliveryId, eventName });
        return { ok: true, duplicate: true };
      }

      // --- 4. Parse JSON (หลัง verify เท่านั้น) ---
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        set.status = 400;
        return { ok: false, reason: "invalid JSON" };
      }

      const action =
        typeof payload === "object" && payload !== null && "action" in payload
          ? String((payload as Record<string, unknown>).action)
          : null;

      // --- 5. Persist delivery ---
      const receivedAt = Date.now();
      db.query(
        "INSERT INTO webhook_deliveries (delivery_id, event, action, payload, received_at) VALUES (?, ?, ?, ?, ?)",
      ).run(deliveryId, eventName, action, rawBody, receivedAt);

      // --- 6. Process event ---
      try {
        if (eventName === "push") {
          await handlePush(db, payload as PushEventPayload, deliveryId, receivedAt);
        } else if (eventName === "installation") {
          await handleInstallation(db, payload as InstallationEventPayload, github);
        } else if (eventName === "installation_repositories") {
          await handleInstallationRepositories(db, payload as InstallationRepositoriesEventPayload);
        }
        // events อื่น ignore อย่างปลอดภัย

        // mark processed
        db.query("UPDATE webhook_deliveries SET processed_at = ? WHERE delivery_id = ?").run(
          Date.now(),
          deliveryId,
        );
      } catch (err) {
        log.error("webhook processing error", {
          deliveryId,
          eventName,
          reason: err instanceof Error ? err.message : String(err),
        });
        // ยังตอบ 200 เพื่อไม่ให้ GitHub retry — delivery อยู่ใน DB แล้ว
        // Phase 3 จะมี retry mechanism สำหรับ failed processing
      }

      return { ok: true };
    },
  );
}

/** Handle push event — สร้าง deploy_intent ถ้าผ่านเงื่อนไขทั้งหมด */
async function handlePush(
  db: Database,
  payload: PushEventPayload,
  deliveryId: string,
  receivedAt: number,
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
    db.query(
      `INSERT INTO deploy_intents
        (id, project_id, installation_id, repo_id, branch, commit_sha, commit_message, commit_author, delivery_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
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

    log.info("deploy intent created", {
      intentId,
      projectId: project.id,
      branch,
      commitSha: commitSha.slice(0, 7), // short SHA สำหรับ log — ไม่ใช่ secret
    });
  }
}

/** Handle installation lifecycle events */
async function handleInstallation(
  db: Database,
  payload: InstallationEventPayload,
  github: GitHubService | null,
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
    if (github) github.invalidateToken(installationId);
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
    if (github) github.invalidateToken(installationId);
    log.info("github installation suspended", { installationId });
  } else if (action === "unsuspend") {
    if (row) {
      db.query(
        "UPDATE github_installations SET status = 'active', updated_at = ? WHERE id = ?",
      ).run(now, row.id);
    }
    log.info("github installation unsuspended", { installationId });
  } else if (action === "created" && !row) {
    // Installation ใหม่ผ่าน webhook (นอกจาก callback flow)
    const id = ulid();
    db.query(
      "INSERT INTO github_installations (id, installation_id, account_login, account_type, account_avatar_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, '', 'active', ?, ?)",
    ).run(id, installationId, installation.account.login, installation.account.type, now, now);
    log.info("github installation created via webhook", { installationId });
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
