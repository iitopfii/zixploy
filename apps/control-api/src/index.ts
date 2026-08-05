import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { databasePath, loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { buildApp } from "./app";
import { log } from "./logger";
import { MAX_BODY_BYTES } from "./plugins/body-limit";

const dbPath = databasePath();
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

const db = openDatabase({ path: dbPath });

// migration ต้องเสร็จก่อน API รับ traffic (docs/phase-01)
const ran = migrateUp(db, loadMigrations(migrationsDir()));
if (ran.length > 0) log.info("applied migrations", { migrations: ran });

const port = Number(process.env.ZIXPLOY_API_PORT ?? 3001);

// bind เฉพาะ loopback — production ให้ Traefik เป็นตัวรับ traffic จากภายนอก
// (docs/phase-01 security; API ต้องไม่ bind public interface โดยตรง)
const app = buildApp(db).listen({
  port,
  hostname: "127.0.0.1",
  maxRequestBodySize: MAX_BODY_BYTES,
});

log.info("control-api listening", { url: `http://127.0.0.1:${port}` });

export type { App } from "./app";
export { app };
