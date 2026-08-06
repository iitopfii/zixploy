/**
 * Deploy Worker — process แยกจาก Control API (ADR-0002)
 * ผู้เดียวในระบบที่จะได้สิทธิ์ Docker Engine (phase 3 เป็นต้นไป)
 *
 * Phase 0-1: entrypoint + heartbeat + graceful shutdown
 * Phase 3 M2: job claim loop (lease/transaction) เพิ่มเข้ามาแล้ว — processJob ยังเป็น stub
 * (M6 จะเสียบ pipeline dispatcher จริงเข้ามาแทน)
 */

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
  assertMigrated,
  databasePath,
  loadMigrations,
  migrationsDir,
  openDatabase,
} from "@zixploy/db";
import { createLogger, DEPLOY_QUEUE, type LogLevel, ulid } from "@zixploy/shared";
import { heartbeatLoop } from "./heartbeat";
import {
  type ClaimedJob,
  claimNextJob,
  completeJob,
  failJob,
  type JobOutcome,
  LeaseLostError,
  withLeaseRenewal,
} from "./queue";

const workerId = `worker-${ulid()}`;
const log = createLogger({
  service: "deploy-worker",
  level: (process.env.ZIXPLOY_LOG_LEVEL as LogLevel | undefined) ?? "info",
});

const dbPath = databasePath();

/** รอ API สร้างและ migrate database — worker ไม่ migrate เอง (ADR-0002) */
async function waitForDatabase(timeoutMs = 30_000): Promise<boolean> {
  if (dbPath === ":memory:" || existsSync(dbPath)) return true;

  log.info("รอ control-api สร้าง database", { workerId, dbPath });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await Bun.sleep(500);
    if (existsSync(dbPath)) return true;
  }
  return false;
}

if (!(await waitForDatabase())) {
  log.error("ไม่พบ database — เปิด control-api ก่อน หรือกำหนด ZIXPLOY_DB_PATH ให้ตรงกับที่ API ใช้", {
    workerId,
    dbPath,
  });
  process.exit(1);
}

const db = openDatabase({ path: dbPath });

// fail closed ถ้า schema ไม่ครบ — เวอร์ชันไม่ตรงแปลว่า API ยัง migrate ไม่เสร็จหรือ deploy ไม่ตรงกัน
try {
  assertMigrated(db, loadMigrations(migrationsDir()));
} catch (e) {
  log.error("schema ไม่ตรงกับ migrations", {
    workerId,
    reason: e instanceof Error ? e.message : String(e),
  });
  process.exit(1);
}

const controller = new AbortController();

function shutdown(reason: string) {
  if (controller.signal.aborted) return;
  log.info("shutting down — หยุดรับงานใหม่, งานที่กำลังทำจะปล่อย lease ให้ recover เอง", {
    workerId,
    reason,
  });
  controller.abort();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/**
 * ประมวลผลงานหนึ่งชิ้น — M2 เป็น stub (mark done ทันที) เพื่อทดสอบ queue mechanics
 * โดยไม่ต้องมี Docker/git pipeline จริง M6 จะแทนที่ด้วย pipeline dispatcher
 */
async function processJob(
  _db: Database,
  job: ClaimedJob,
  _signal: AbortSignal,
): Promise<JobOutcome> {
  log.info("processing job (stub — M6 จะเพิ่ม pipeline จริง)", {
    workerId,
    jobId: job.id,
    type: job.type,
    projectId: job.projectId,
  });
  return { outcome: "done" };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

async function jobLoop(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const job = claimNextJob(db, workerId, DEPLOY_QUEUE.leaseMs);
    if (!job) {
      await sleep(DEPLOY_QUEUE.pollIntervalMs, signal);
      continue;
    }

    log.info("job claimed", { workerId, jobId: job.id, type: job.type, projectId: job.projectId });
    try {
      const result = await withLeaseRenewal(db, job, workerId, (jobSignal) =>
        processJob(db, job, jobSignal),
      );
      if (result.outcome === "done") {
        completeJob(db, job.id);
        log.info("job completed", { workerId, jobId: job.id });
      } else {
        failJob(db, job.id, { retryable: result.retryable });
        log.warn("job failed", { workerId, jobId: job.id, retryable: result.retryable });
      }
    } catch (err) {
      if (err instanceof LeaseLostError) {
        // lease หลุดไปแล้ว (recover หรือ cancel) — เจ้าของใหม่/recovery จัดการเอง ไม่แตะซ้ำ
        log.warn("job lease lost ระหว่างทำงาน", { workerId, jobId: job.id, reason: err.reason });
        continue;
      }
      // exception ที่ไม่คาดคิด (bug) — ปฏิบัติเป็น retryable failure เป็น safety net
      log.error("job processing threw unexpectedly", {
        workerId,
        jobId: job.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      failJob(db, job.id, { retryable: true });
    }
  }
}

log.info("deploy-worker started", { workerId });

await Promise.all([heartbeatLoop(db, workerId, controller.signal), jobLoop(controller.signal)]);

log.info("deploy-worker stopped", { workerId });
