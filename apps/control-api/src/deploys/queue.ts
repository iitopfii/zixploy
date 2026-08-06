/**
 * Deploy job enqueue logic — control-api ฝั่งเดียวที่ INSERT ลง deploy_jobs (ADR-0002)
 *
 * Worker (apps/deploy-worker) claim/update งานที่มีอยู่เท่านั้น ไม่เคยสร้างงานใหม่
 * ฟังก์ชันในไฟล์นี้คือจุดตัดสินใจว่า "ต้องมีงานนี้ไหม" ทั้งหมดของระบบ
 *
 * Path push (webhook): coalesce เข้า pending job เดิมถ้ามี — ไม่ error, auto-deploy ต้องไม่บล็อกผู้ใช้
 * Path manual/redeploy/rollback/restart/stop: throw DEPLOY_ALREADY_ACTIVE ถ้ามีงาน pending/leased อยู่แล้ว
 *   — ผู้ใช้กดเองต้องได้ feedback ชัดเจนว่าทำไม่ได้ตอนนี้ ไม่ใช่เงียบ ๆ ต่อคิว
 */

import type { Database } from "bun:sqlite";
import { AppError, type DeploymentStatus, isTerminal, ulid } from "@zixploy/shared";

export type DeployJobPayload =
  | {
      kind: "build";
      trigger: "push" | "manual" | "redeploy";
      commitSha: string;
      commitMessage: string | null;
      commitAuthor: string | null;
      installationId: number;
      repoFullName: string;
    }
  | { kind: "rollback"; targetDeploymentId: string; imageTag: string; imageDigest: string }
  | { kind: "restart" }
  | { kind: "stop" };

/** priority: manual actions แซง auto-deploy push ที่ต่อคิวอยู่ (แต่ไม่แซง job ที่ leased ไปแล้ว) */
const PRIORITY = { push: 0, manual: 10, operation: 20 } as const;

function activeJobFor(
  db: Database,
  projectId: string,
): { id: string; status: string; deployment_id: string | null } | null {
  return (
    db
      .query<{ id: string; status: string; deployment_id: string | null }, [string]>(
        "SELECT id, status, deployment_id FROM deploy_jobs WHERE project_id = ? AND type = 'deploy' AND status IN ('pending', 'leased')",
      )
      .get(projectId) ?? null
  );
}

function pendingJobFor(
  db: Database,
  projectId: string,
): { id: string; deployment_id: string | null } | null {
  return (
    db
      .query<{ id: string; deployment_id: string | null }, [string]>(
        "SELECT id, deployment_id FROM deploy_jobs WHERE project_id = ? AND type = 'deploy' AND status = 'pending'",
      )
      .get(projectId) ?? null
  );
}

export interface PushDeployParams {
  projectId: string;
  installationId: number;
  repoFullName: string;
  commitSha: string;
  commitMessage: string | null;
  commitAuthor: string | null;
}

/**
 * Push path (จาก webhook handlePush) — coalesce เข้า pending job เดิมถ้ามี (เก็บ commit ล่าสุด)
 * ไม่ throw แม้มี job leased อยู่ — สร้าง pending job ใหม่คิวต่อได้เสมอ (2-partial-index design, migration 0006)
 */
export function enqueuePushDeploy(
  db: Database,
  params: PushDeployParams,
): { deploymentId: string; coalesced: boolean } {
  const now = Date.now();
  const existing = pendingJobFor(db, params.projectId);

  if (existing?.deployment_id) {
    const payload: DeployJobPayload = {
      kind: "build",
      trigger: "push",
      commitSha: params.commitSha,
      commitMessage: params.commitMessage,
      commitAuthor: params.commitAuthor,
      installationId: params.installationId,
      repoFullName: params.repoFullName,
    };
    const run = db.transaction(() => {
      db.query("UPDATE deploy_jobs SET payload = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify(payload),
        now,
        existing.id,
      );
      db.query(
        "UPDATE deployments SET commit_sha = ?, commit_message = ?, commit_author = ?, updated_at = ? WHERE id = ?",
      ).run(
        params.commitSha,
        params.commitMessage,
        params.commitAuthor,
        now,
        existing.deployment_id,
      );
    });
    run();
    return { deploymentId: existing.deployment_id, coalesced: true };
  }

  const deploymentId = ulid();
  const jobId = ulid();
  const payload: DeployJobPayload = {
    kind: "build",
    trigger: "push",
    commitSha: params.commitSha,
    commitMessage: params.commitMessage,
    commitAuthor: params.commitAuthor,
    installationId: params.installationId,
    repoFullName: params.repoFullName,
  };
  const run = db.transaction(() => {
    db.query(
      `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, commit_message, commit_author, queued_at, created_at, updated_at)
       VALUES (?, ?, 'queued', 'push', ?, ?, ?, ?, ?, ?)`,
    ).run(
      deploymentId,
      params.projectId,
      params.commitSha,
      params.commitMessage,
      params.commitAuthor,
      now,
      now,
      now,
    );
    db.query(
      `INSERT INTO deploy_jobs (id, project_id, deployment_id, type, status, payload, priority, max_attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'deploy', 'pending', ?, ?, 1, ?, ?)`,
    ).run(jobId, params.projectId, deploymentId, JSON.stringify(payload), PRIORITY.push, now, now);
  });
  run();
  return { deploymentId, coalesced: false };
}

export interface ManualDeployParams {
  projectId: string;
  trigger: "manual" | "redeploy" | "rollback";
  commitSha: string;
  commitMessage: string | null;
  commitAuthor: string | null;
  payload: DeployJobPayload;
}

/**
 * Manual/redeploy/rollback path — throw DEPLOY_ALREADY_ACTIVE ถ้ามี job pending หรือ leased อยู่แล้ว
 * (ต่างจาก push ตรงที่ผู้ใช้กดเองต้องรู้ทันทีว่าทำไม่ได้ ไม่ต่อคิวเงียบ ๆ)
 */
export function enqueueManualJob(
  db: Database,
  params: ManualDeployParams,
): { deploymentId: string } {
  const active = activeJobFor(db, params.projectId);
  if (active) {
    throw new AppError("DEPLOY_ALREADY_ACTIVE", "มี deploy กำลังทำงานอยู่แล้วสำหรับ project นี้");
  }

  const now = Date.now();
  const deploymentId = ulid();
  const jobId = ulid();
  const run = db.transaction(() => {
    db.query(
      `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, commit_message, commit_author, queued_at, created_at, updated_at)
       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      deploymentId,
      params.projectId,
      params.trigger,
      params.commitSha,
      params.commitMessage,
      params.commitAuthor,
      now,
      now,
      now,
    );
    db.query(
      `INSERT INTO deploy_jobs (id, project_id, deployment_id, type, status, payload, priority, max_attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'deploy', 'pending', ?, ?, 1, ?, ?)`,
    ).run(
      jobId,
      params.projectId,
      deploymentId,
      JSON.stringify(params.payload),
      PRIORITY.manual,
      now,
      now,
    );
  });
  run();
  return { deploymentId };
}

/**
 * restart/stop — ไม่สร้าง deployments row ใหม่ อ้างอิง deployment ที่ succeeded ล่าสุดของ project
 * throw VALIDATION_ERROR ถ้าไม่มี deployment succeeded ให้ restart/stop เลย
 */
export function enqueueOperation(
  db: Database,
  projectId: string,
  kind: "restart" | "stop",
): { jobId: string; deploymentId: string } {
  const active = activeJobFor(db, projectId);
  if (active) {
    throw new AppError("DEPLOY_ALREADY_ACTIVE", "มี deploy กำลังทำงานอยู่แล้วสำหรับ project นี้");
  }

  const activeDeployment = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM deployments WHERE project_id = ? AND status = 'succeeded' ORDER BY finished_at DESC LIMIT 1",
    )
    .get(projectId);
  if (!activeDeployment) {
    throw new AppError("VALIDATION_ERROR", `ไม่มี deployment ที่ succeeded ให้ ${kind}`, {
      field: "projectId",
    });
  }

  const now = Date.now();
  const jobId = ulid();
  const payload: DeployJobPayload = kind === "restart" ? { kind: "restart" } : { kind: "stop" };
  db.query(
    `INSERT INTO deploy_jobs (id, project_id, deployment_id, type, status, payload, priority, max_attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'deploy', 'pending', ?, ?, 1, ?, ?)`,
  ).run(
    jobId,
    projectId,
    activeDeployment.id,
    JSON.stringify(payload),
    PRIORITY.operation,
    now,
    now,
  );

  return { jobId, deploymentId: activeDeployment.id };
}

/**
 * Cancel: pending job → cancel ทันที (ยังไม่มีใครแตะ). leased job → ตั้ง cancel_requested_at แทนที่จะ
 * แตะ status/lease โดยตรง (กัน race กับ worker ที่ถือ lease อยู่ — ADR-0002); worker poll flag นี้เอง
 * Idempotent: deployment ที่ terminal อยู่แล้วไม่ถูกแตะซ้ำ
 */
export function cancelDeployment(db: Database, deploymentId: string): void {
  const now = Date.now();
  const job = db
    .query<{ id: string; status: string }, [string]>(
      "SELECT id, status FROM deploy_jobs WHERE deployment_id = ?",
    )
    .get(deploymentId);

  if (!job) {
    const deployment = db
      .query<{ status: string }, [string]>("SELECT status FROM deployments WHERE id = ?")
      .get(deploymentId);
    if (deployment && !isTerminal(deployment.status as DeploymentStatus)) {
      db.query(
        "UPDATE deployments SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?",
      ).run(now, now, deploymentId);
    }
    return;
  }

  if (job.status === "pending") {
    const run = db.transaction(() => {
      db.query("UPDATE deploy_jobs SET status = 'cancelled', updated_at = ? WHERE id = ?").run(
        now,
        job.id,
      );
      db.query(
        `UPDATE deployments SET status = 'cancelled', finished_at = ?, updated_at = ?
         WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'cancelled')`,
      ).run(now, now, deploymentId);
    });
    run();
    return;
  }

  if (job.status === "leased") {
    db.query("UPDATE deploy_jobs SET cancel_requested_at = ?, updated_at = ? WHERE id = ?").run(
      now,
      now,
      job.id,
    );
    return;
  }

  // done/failed/cancelled — no-op, deployment น่าจะ terminal อยู่แล้ว
}
