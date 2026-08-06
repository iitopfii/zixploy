import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { databasePath, loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { buildApp } from "./app";
import { loadMasterKeys } from "./crypto/master-key";
import { RealGitHubAppRegistry } from "./github/registry";
import { log } from "./logger";
import { MAX_BODY_BYTES } from "./plugins/body-limit";

const dbPath = databasePath();
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

const db = openDatabase({ path: dbPath });

// migration ต้องเสร็จก่อน API รับ traffic (docs/phase-01)
const ran = migrateUp(db, loadMigrations(migrationsDir()));
if (ran.length > 0) log.info("applied migrations", { migrations: ran });

/**
 * Master key สำหรับเข้ารหัส GitHub App credentials (docs/encryption.md)
 * ไม่ตั้งค่า → GitHub App features ปิด แต่ Phase 1 ยังทำงานได้
 * ตั้งค่าแต่ไฟล์ผิด → fail closed (ไม่เปิด service แบบ encryption ครึ่งเดียว)
 */
const masterKeys = await loadMasterKeys();
if (masterKeys) {
  log.info("master key loaded", { activeKeyId: masterKeys.active, keyCount: masterKeys.keys.size });
} else {
  log.info("master key not configured — ตั้ง ZIXPLOY_MASTER_KEY_FILE เพื่อสร้าง GitHub App");
}

// Public base URL ที่ GitHub เข้าถึงได้ — ใช้ใน manifest webhook/setup URLs
const baseUrl = process.env.ZIXPLOY_BASE_URL ?? "http://localhost:3001";

const registry = new RealGitHubAppRegistry(db, { baseUrl, masterKeys });

const appCount = registry.listApps().length;
if (appCount > 0) log.info("github apps configured", { count: appCount });

const port = Number(process.env.ZIXPLOY_API_PORT ?? 3001);

// bind เฉพาะ loopback — production ให้ Traefik เป็นตัวรับ traffic จากภายนอก
// (docs/phase-01 security; API ต้องไม่ bind public interface โดยตรง)
const app = buildApp(db, { registry, baseUrl, masterKeys }).listen({
  port,
  hostname: "127.0.0.1",
  maxRequestBodySize: MAX_BODY_BYTES,
});

log.info("control-api listening", { url: `http://127.0.0.1:${port}` });

export type { App } from "./app";
export { app };
