/**
 * Deploy Worker — process แยกจาก Control API (ADR-0002)
 * ผู้เดียวในระบบที่จะได้สิทธิ์ Docker Engine (phase 3 เป็นต้นไป)
 *
 * Phase 0-1: entrypoint + heartbeat + graceful shutdown
 * Phase 3 จะเพิ่ม: job claim loop (lease/transaction), build pipeline, cleanup
 */
import { existsSync } from "node:fs";
import {
  assertMigrated,
  databasePath,
  loadMigrations,
  migrationsDir,
  openDatabase,
} from "@zixploy/db";
import { createLogger, type LogLevel, ulid } from "@zixploy/shared";
import { heartbeatLoop } from "./heartbeat";

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
  log.info("shutting down", { workerId, reason });
  // phase 3: หยุดรับงานใหม่ + คืน/ต่ออายุ lease ให้เรียบร้อยก่อนออก
  controller.abort();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log.info("deploy-worker started", { workerId });

await heartbeatLoop(db, workerId, controller.signal);

log.info("deploy-worker stopped", { workerId });
