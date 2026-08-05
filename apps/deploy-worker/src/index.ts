/**
 * Deploy Worker — process แยกจาก Control API (ADR-0002)
 * ผู้เดียวในระบบที่จะได้สิทธิ์ Docker Engine (phase 3 เป็นต้นไป)
 *
 * Phase 0: entrypoint + heartbeat + graceful shutdown
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
import { ulid } from "@zixploy/shared";
import { heartbeatLoop } from "./heartbeat";

const workerId = `worker-${ulid()}`;
const dbPath = databasePath();

// worker ไม่สร้าง database เอง — API เป็นผู้ migrate; ไม่มีไฟล์ = ยังไม่ได้เปิด API
if (dbPath !== ":memory:" && !existsSync(dbPath)) {
  console.error(
    `ไม่พบ database ที่ ${dbPath} — เปิด control-api ก่อนเพื่อสร้างและ migrate ` +
      `(หรือกำหนด ZIXPLOY_DB_PATH ให้ตรงกับที่ API ใช้)`,
  );
  process.exit(1);
}

const db = openDatabase({ path: dbPath });

// worker ไม่รัน migration เอง — fail closed ถ้า schema ไม่ครบ (API เป็นคน migrate)
try {
  assertMigrated(db, loadMigrations(migrationsDir()));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const controller = new AbortController();

function shutdown(reason: string) {
  if (controller.signal.aborted) return;
  console.log(JSON.stringify({ level: "info", workerId, message: `shutting down: ${reason}` }));
  // phase 3: หยุดรับงานใหม่ + คืน/ต่ออายุ lease ให้เรียบร้อยก่อนออก
  controller.abort();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(JSON.stringify({ level: "info", workerId, message: "deploy-worker started" }));

await heartbeatLoop(db, workerId, controller.signal);

console.log(JSON.stringify({ level: "info", workerId, message: "deploy-worker stopped" }));
