import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import type { GitHubAppRegistry } from "./github/registry";
import { RealGitHubAppRegistry } from "./github/registry";
import { bodyLimit } from "./plugins/body-limit";
import { errorHandler } from "./plugins/error-handler";
import { requestId } from "./plugins/request-id";
import { requestLog } from "./plugins/request-log";
import { securityHeaders } from "./plugins/security-headers";
import { authRoutes } from "./routes/auth";
import { githubRoutes } from "./routes/github";
import { projectRoutes } from "./routes/projects";
import { systemRoutes } from "./routes/system";
import { webhookRoutes } from "./routes/webhook";

/**
 * ประกอบ Elysia app จาก plugins + route modules
 * แยกจาก index.ts เพื่อให้ tests เรียก app.handle() ได้โดยไม่เปิด listener
 *
 * registry: จัดการ GitHub Apps ที่สร้างผ่าน manifest flow
 *   - ไม่ระบุ → สร้าง registry เปล่า (ไม่มี master key) — Phase 1 functionality ยังทำงานได้
 *   - tests ฉีด mock registry ได้
 */
export interface AppOptions {
  registry?: GitHubAppRegistry;
  /** Public base URL — ใช้สร้าง webhook/setup URL ใน manifest (default: localhost) */
  baseUrl?: string;
}

export function buildApp(db: Database, options: AppOptions = {}) {
  const registry =
    options.registry ??
    new RealGitHubAppRegistry(db, {
      baseUrl: options.baseUrl ?? "http://localhost:3001",
      masterKeys: null,
    });

  return new Elysia()
    .use(requestId)
    .use(requestLog)
    .use(securityHeaders)
    .use(bodyLimit)
    .use(errorHandler)
    .use(systemRoutes(db))
    .use(authRoutes(db))
    .use(projectRoutes(db))
    .use(githubRoutes(db, registry))
    .use(webhookRoutes(db, registry));
}

export type App = ReturnType<typeof buildApp>;
