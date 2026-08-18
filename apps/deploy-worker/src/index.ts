/**
 * Deploy Worker — process แยกจาก Control API (ADR-0002)
 * ผู้เดียวในระบบที่จะได้สิทธิ์ Docker Engine
 *
 * Phase 0-1: entrypoint + heartbeat + graceful shutdown
 * Phase 3 M2: job claim loop (lease/transaction)
 * Phase 3 M6: pipeline dispatcher จริง (clone→build→start→health→activate→rollback/restart/stop)
 */
import { existsSync } from "node:fs";
import {
  assertMigrated,
  databasePath,
  loadMigrations,
  migrationsDir,
  openDatabase,
} from "@zixploy/db";
import { createLogger, DEPLOY_QUEUE, type LogLevel, ulid } from "@zixploy/shared";
import { DockerCliClient } from "./docker/cli-client";
import { loadMasterKeys } from "./github/master-key";
import { heartbeatLoop } from "./heartbeat";
import { dockerInventoryLoop } from "./inventory/loop";
import { runtimeLogLoop } from "./logs/runtime-poller";
import { serviceLogLoop } from "./logs/service-poller";
import { maintenanceLoop } from "./maintenance/loop";
import { metricsLoop } from "./metrics/collector";
import { createDispatcher } from "./pipeline/dispatch";
import { claimNextJob, completeJob, failJob, LeaseLostError, withLeaseRenewal } from "./queue";
import { stateReconcileLoop } from "./reconciler";
import { backupScheduleLoop } from "./services/backup-schedule-loop";
import { serviceJobLoop } from "./services/loop";
import { terminalSessionLoop } from "./services/terminal-session-loop";
import { volumeReconcileLoop } from "./volumes/reconciler";

/** mount point ของ zixploy-backups volume ในนี้ — เดียวกับที่ control-api backup ตัวเอง */
const backupsDir = process.env.ZIXPLOY_BACKUPS_DIR ?? "/backups";
/** base URL ของ control-api บน zixploy-internal network — worker ต่อ WebSocket ออกไปหาตรง ๆ
 *  สำหรับ terminal relay (Phase 17) ไม่ผ่าน Traefik (ดู services/terminal-session-loop.ts)
 *  ค่า default ตรงกับ service name "control-api" + ZIXPLOY_API_PORT ใน docker-compose.yml */
const controlApiUrl = process.env.ZIXPLOY_CONTROL_API_URL ?? "http://control-api:3001";

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

/**
 * Master key สำหรับ decrypt GitHub App PEM (ดู github/master-key.ts) — worker ต้อง mint
 * installation token เอง ไม่ผ่าน control-api (ADR-0002) ไม่ตั้งค่า → build job จะ fail ตอน mint token
 * เท่านั้น (queue mechanics/restart/stop ยังทำงานได้ตามปกติ)
 */
const masterKeys = await loadMasterKeys();
if (masterKeys) {
  log.info("master key loaded", { workerId, activeKeyId: masterKeys.active });
} else {
  log.info("master key not configured — build job ที่ต้อง clone repo จะ fail ตอน mint token", {
    workerId,
  });
}

const docker = new DockerCliClient();

const processJob = createDispatcher({
  db,
  masterKeys,
  docker,
  onLog: (line) => log.debug("build output", { workerId, line }),
});

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

await Promise.all([
  heartbeatLoop(db, workerId, controller.signal),
  jobLoop(controller.signal),
  runtimeLogLoop(db, docker, controller.signal),
  serviceLogLoop(db, docker, controller.signal),
  volumeReconcileLoop(db, docker, controller.signal),
  stateReconcileLoop(db, docker, controller.signal, (line) => log.warn(line, { workerId })),
  metricsLoop(db, docker, controller.signal, {
    onLog: (line) => log.warn(line, { workerId }),
  }),
  // snapshot รายชื่อ container/image ทั้งเครื่อง → หน้า Docker ใน dashboard (ADR-0002)
  dockerInventoryLoop(db, docker, controller.signal, (line) => log.warn(line, { workerId })),
  // คิวแยกจาก deploy — database provisioning ใช้เวลานาน ไม่ควรบล็อก deploy ของ app
  serviceJobLoop(db, docker, workerId, controller.signal, {
    masterKeys,
    backupsDir,
    onLog: (line) => log.info(line, { workerId }),
  }),
  maintenanceLoop(db, workerId, controller.signal, (line) => log.info(line, { workerId })),
  // scheduled backup — ไม่ผ่าน service_jobs queue เลย (ดู services/backup-schedule-loop.ts)
  backupScheduleLoop(db, docker, backupsDir, controller.signal, (line) =>
    log.info(line, { workerId }),
  ),
  // interactive terminal เข้า container ของ managed service — ไม่ผ่าน service_jobs queue เช่นกัน
  // (ดู services/terminal-session-loop.ts)
  terminalSessionLoop(db, docker, controlApiUrl, controller.signal, {
    onLog: (line) => log.info(line, { workerId }),
  }),
]);

log.info("deploy-worker stopped", { workerId });
