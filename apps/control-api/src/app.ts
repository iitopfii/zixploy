import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import type { MasterKeys } from "./crypto/master-key";
import type { GitHubAppRegistry } from "./github/registry";
import { RealGitHubAppRegistry } from "./github/registry";
import { bodyLimit } from "./plugins/body-limit";
import { errorHandler } from "./plugins/error-handler";
import { originGuard } from "./plugins/origin-guard";
import { requestId } from "./plugins/request-id";
import { requestLog } from "./plugins/request-log";
import { securityHeaders } from "./plugins/security-headers";
import { auditRoutes } from "./routes/audit";
import { authRoutes } from "./routes/auth";
import { componentRoutes } from "./routes/components";
import { deploymentRoutes } from "./routes/deployments";
import { dockerInventoryRoutes } from "./routes/docker-inventory";
import { dockerfileSourceRoutes } from "./routes/dockerfile-source";
import { domainRoutes } from "./routes/domains";
import { environmentRoutes } from "./routes/environment";
import { githubRoutes } from "./routes/github";
import { logRoutes } from "./routes/logs";
import { monitoringRoutes } from "./routes/monitoring";
import { projectRoutes } from "./routes/projects";
import { serviceRoutes } from "./routes/services";
import { systemRoutes } from "./routes/system";
import { systemSettingsRoutes } from "./routes/system-settings";
import { type TerminalRouteOptions, terminalRoutes } from "./routes/terminal";
import { updateRoutes } from "./routes/updates";
import { volumeRoutes } from "./routes/volumes";
import { webhookRoutes } from "./routes/webhook";
import { createSettingsStore } from "./settings/store";

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
  /** override timeout ของ terminal relay (Phase 17) — ใช้ในเทสต์เท่านั้น ปกติไม่ต้องระบุ */
  terminal?: TerminalRouteOptions;
}

export function buildApp(db: Database, options: AppOptions = {}) {
  const masterKeys = options.masterKeys ?? null;
  const baseUrl = options.baseUrl ?? "http://localhost:3001";

  const registry =
    options.registry ??
    new RealGitHubAppRegistry(db, {
      baseUrl,
      masterKeys,
    });

  // dashboard domain ที่ตั้งจาก UI — origin-guard อ่านผ่าน cache ใน store มีผลทันทีไม่ต้อง restart
  const settingsStore = createSettingsStore(db);

  return new Elysia()
    .use(requestId)
    .use(requestLog)
    .use(originGuard(baseUrl, { extraHost: () => settingsStore.getDashboardDomain() }))
    .use(securityHeaders)
    .use(bodyLimit)
    .use(errorHandler)
    .use(systemRoutes(db))
    .use(authRoutes(db))
    .use(projectRoutes(db))
    .use(githubRoutes(db, registry))
    .use(dockerfileSourceRoutes(db))
    .use(deploymentRoutes(db, registry))
    .use(webhookRoutes(db, registry))
    .use(environmentRoutes(db, masterKeys))
    .use(domainRoutes(db, masterKeys))
    .use(logRoutes(db))
    .use(volumeRoutes(db))
    .use(serviceRoutes(db, masterKeys))
    .use(componentRoutes(db))
    .use(terminalRoutes(db, options.terminal))
    .use(monitoringRoutes(db))
    .use(dockerInventoryRoutes(db))
    .use(updateRoutes(db))
    .use(systemSettingsRoutes(db, settingsStore))
    .use(auditRoutes(db));
}

export type App = ReturnType<typeof buildApp>;
