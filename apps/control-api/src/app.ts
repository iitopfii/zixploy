import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import type { GitHubService } from "./github/service";
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
 * github: null = GitHub App ยังไม่ได้ configure — Phase 1 functionality ยังทำงานได้
 * webhookSecret: ส่งแยกจาก GitHubService เพราะ webhook endpoint เป็น public
 *   และอาจรัน/ทดสอบแยกจาก service ได้
 */
export interface AppOptions {
  github?: GitHubService | null;
  webhookSecret?: string;
}

export function buildApp(db: Database, options: AppOptions = {}) {
  const github = options.github ?? null;
  const webhookSecret = options.webhookSecret;

  return new Elysia()
    .use(requestId)
    .use(requestLog)
    .use(securityHeaders)
    .use(bodyLimit)
    .use(errorHandler)
    .use(systemRoutes(db))
    .use(authRoutes(db))
    .use(projectRoutes(db))
    .use(githubRoutes(db, github))
    .use(webhookRoutes(db, github, webhookSecret));
}

export type App = ReturnType<typeof buildApp>;
