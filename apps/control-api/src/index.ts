import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { databasePath, loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { buildApp } from "./app";
import { loadMasterKeys } from "./crypto/master-key";
import { syncCertificates } from "./domains/tls-sync";
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

/**
 * Regenerate custom TLS certificate files ตอนบูต (Phase 5 M5)
 *
 * DB เป็น source of truth เสมอ — ไฟล์บน volume เป็นแค่ projection ให้ Traefik อ่าน
 * sync ตอนบูตจึงกู้สถานะได้ทุกกรณี: container ใหม่, volume ว่าง, restore จาก backup
 * ที่ไม่ได้รวม cert volume, หรือไฟล์ถูกลบด้วยมือ
 *
 * ไม่ block การ start — sync ล้มเหลวหมายถึง custom cert ยังไม่ขึ้น (Traefik fallback
 * ไปใช้ ACME/default cert) แต่ API ต้องขึ้นให้ผู้ใช้เข้ามาแก้ได้
 */
const certSync = await syncCertificates(db, masterKeys);
if (!certSync.ok) {
  log.warn("sync custom certificates ไม่สำเร็จตอนบูต — custom TLS อาจยังไม่ทำงาน");
}

// Public base URL ที่ GitHub เข้าถึงได้ — ใช้ใน manifest webhook/setup URLs
const baseUrl = process.env.ZIXPLOY_BASE_URL ?? "http://localhost:3001";

const registry = new RealGitHubAppRegistry(db, { baseUrl, masterKeys });

const appCount = registry.listApps().length;
if (appCount > 0) log.info("github apps configured", { count: appCount });

const port = Number(process.env.ZIXPLOY_API_PORT ?? 3001);

// bind address — ค่า default 127.0.0.1 (loopback เท่านั้น, เหมาะกับ bare-metal + host Traefik)
// ใน Docker ให้ตั้ง ZIXPLOY_BIND_HOST=0.0.0.0 เพื่อให้ Traefik container เชื่อมต่อได้ผ่าน Docker network
// (isolation ใน Docker มาจาก network segmentation: zixploy-internal + expose ไม่ใช่ ports)
const bindHost = process.env.ZIXPLOY_BIND_HOST ?? "127.0.0.1";
const app = buildApp(db, { registry, baseUrl, masterKeys }).listen({
  port,
  hostname: bindHost,
  maxRequestBodySize: MAX_BODY_BYTES,
});

log.info("control-api listening", { url: `http://${bindHost}:${port}` });

export type { App } from "./app";
export { app };
