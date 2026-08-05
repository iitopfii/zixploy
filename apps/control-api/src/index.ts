import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { databasePath, loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { buildApp } from "./app";

const dbPath = databasePath();
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

const db = openDatabase({ path: dbPath });

// migration ต้องเสร็จก่อน API รับ traffic (docs/phase-01)
const ran = migrateUp(db, loadMigrations(migrationsDir()));
if (ran.length > 0) console.log(`applied migrations: ${ran.join(", ")}`);

const port = Number(process.env.ZIXPLOY_API_PORT ?? 3001);
const app = buildApp(db).listen({ port, hostname: "127.0.0.1" });

console.log(`control-api listening on http://127.0.0.1:${port}`);

// อย่า bind public interface ตรง ๆ — production อยู่หลัง Traefik (docs/phase-01 security)
export type { App } from "./app";
export { app };
