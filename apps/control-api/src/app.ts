import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { errorHandler } from "./plugins/error-handler";
import { requestId } from "./plugins/request-id";
import { systemRoutes } from "./routes/system";

/**
 * ประกอบ Elysia app จาก plugins + route modules
 * แยกจาก index.ts เพื่อให้ tests เรียก app.handle() ได้โดยไม่เปิด listener
 */
export function buildApp(db: Database) {
  return new Elysia().use(requestId).use(errorHandler).use(systemRoutes(db));
}

export type App = ReturnType<typeof buildApp>;
