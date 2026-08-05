import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { bodyLimit } from "./plugins/body-limit";
import { errorHandler } from "./plugins/error-handler";
import { requestId } from "./plugins/request-id";
import { securityHeaders } from "./plugins/security-headers";
import { authRoutes } from "./routes/auth";
import { projectRoutes } from "./routes/projects";
import { systemRoutes } from "./routes/system";

/**
 * ประกอบ Elysia app จาก plugins + route modules
 * แยกจาก index.ts เพื่อให้ tests เรียก app.handle() ได้โดยไม่เปิด listener
 */
export function buildApp(db: Database) {
  return new Elysia()
    .use(requestId)
    .use(securityHeaders)
    .use(bodyLimit)
    .use(errorHandler)
    .use(systemRoutes(db))
    .use(authRoutes(db))
    .use(projectRoutes(db));
}

export type App = ReturnType<typeof buildApp>;
