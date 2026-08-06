import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import type { MasterKeys } from "./crypto/master-key";
import type { GitHubAppRegistry } from "./github/registry";
import { RealGitHubAppRegistry } from "./github/registry";
import { bodyLimit } from "./plugins/body-limit";
import { errorHandler } from "./plugins/error-handler";
import { requestId } from "./plugins/request-id";
import { requestLog } from "./plugins/request-log";
import { securityHeaders } from "./plugins/security-headers";
import { authRoutes } from "./routes/auth";
import { deploymentRoutes } from "./routes/deployments";
import { domainRoutes } from "./routes/domains";
import { environmentRoutes } from "./routes/environment";
import { githubRoutes } from "./routes/github";
import { logRoutes } from "./routes/logs";
import { projectRoutes } from "./routes/projects";
import { systemRoutes } from "./routes/system";
import { volumeRoutes } from "./routes/volumes";
import { webhookRoutes } from "./routes/webhook";

/**
 * ประกอบ Elysia app จาก plugins + route modules
 * แยกจาก index.ts เพื่อให้ tests เรียก app.handle() ได้โดยไม่เปิด listener
 *
 * registry: จัดการ GitHub Apps ที่สร้างผ่าน manifest flow
 *   - ไม่ระบุ → สร้าง registry เปล่า (ไม่มี master key) — Phase 1 functionality ยังทำงานได้
 *   - tests ฉีด mock registry ได้
 *
 * masterKeys: สำหรับเข้ารหัส/ถอดรหัส environment variables (Phase 4)
 *   - ไม่ระบุ → GET environment ทำงานได้, PUT/import/validate ต้องการ key → 503
 */
export interface AppOptions {
  registry?: GitHubAppRegistry;
  /** Public base URL — ใช้สร้าง webhook/setup URL ใน manifest (default: localhost) */
  baseUrl?: string;
  /** Master keys สำหรับ encrypt/decrypt environment variables (Phase 4) */
  masterKeys?: MasterKeys | null;
}

export function buildApp(db: Database, options: AppOptions = {}) {
  const masterKeys = options.masterKeys ?? null;

  const registry =
    options.registry ??
    new RealGitHubAppRegistry(db, {
      baseUrl: options.baseUrl ?? "http://localhost:3001",
      masterKeys,
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
    .use(deploymentRoutes(db, registry))
    .use(webhookRoutes(db, registry))
    .use(environmentRoutes(db, masterKeys))
    .use(domainRoutes(db))
    .use(logRoutes(db))
    .use(volumeRoutes(db));
}

export type App = ReturnType<typeof buildApp>;
