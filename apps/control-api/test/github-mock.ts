/**
 * Mock GitHubService + GitHubAppRegistry สำหรับเทสต์ — ไม่เรียก GitHub API จริง
 *
 * ออกแบบให้ configure ได้ต่อ test case:
 *   const registry = createMockRegistry({ repos: [...], forbiddenRepos: ["owner/bad"] })
 *   const app = buildApp(db, { registry })
 */

import { AppError } from "@zixploy/shared";
import type { GitHubAppRegistry, GitHubAppSummary } from "../src/github/registry";
import type {
  Branch,
  GitHubService,
  Installation,
  ListReposResult,
  Repository,
} from "../src/github/service";

export interface MockGitHubOptions {
  installUrl?: string;
  installation?: Installation;
  repos?: Repository[];
  totalCount?: number;
  branches?: Branch[];
  /** full_names ที่ getRepo จะโยน INSTALLATION_NOT_FOUND */
  forbiddenRepos?: string[];
  /** branches ที่ไม่มีอยู่ */
  missingBranches?: string[];
  /** โยน GITHUB_UNAVAILABLE เมื่อเรียก listRepos */
  listReposError?: boolean;
  invalidatedTokens?: number[];
}

export function createMockGitHub(options: MockGitHubOptions = {}): GitHubService & {
  invalidatedTokens: number[];
} {
  const invalidatedTokens: number[] = [];

  const defaultInstallation: Installation = {
    installationId: 12345,
    accountLogin: "test-org",
    accountType: "Organization",
    accountAvatarUrl: "https://avatars.githubusercontent.com/u/12345",
    suspended: false,
  };

  const defaultRepo: Repository = {
    id: 99999,
    name: "my-app",
    fullName: "test-org/my-app",
    private: true,
    defaultBranch: "main",
    description: "test repo",
  };

  const defaultBranches: Branch[] = [
    { name: "main", protected: true },
    { name: "develop", protected: false },
    { name: "feature/x", protected: false },
  ];

  return {
    invalidatedTokens,

    getInstallUrl() {
      return options.installUrl ?? "https://github.com/apps/test-app/installations/new";
    },

    async fetchInstallation(_installationId: number): Promise<Installation> {
      return options.installation ?? defaultInstallation;
    },

    async listRepos(
      _installationId: number,
      opts: { page?: number; perPage?: number } = {},
    ): Promise<ListReposResult> {
      if (options.listReposError) {
        throw new AppError("GITHUB_UNAVAILABLE", "GitHub API error (mock)");
      }
      const repos = options.repos ?? [defaultRepo];
      return {
        items: repos,
        totalCount: options.totalCount ?? repos.length,
        page: opts.page ?? 1,
        perPage: opts.perPage ?? 30,
      };
    },

    async validateRepo(_installationId: number, repoFullName: string): Promise<Repository> {
      if (options.forbiddenRepos?.includes(repoFullName)) {
        throw new AppError("INSTALLATION_NOT_FOUND", `ไม่มีสิทธิ์เข้าถึง ${repoFullName}`);
      }
      const repo = (options.repos ?? [defaultRepo]).find((r) => r.fullName === repoFullName);
      if (!repo) {
        throw new AppError("INSTALLATION_NOT_FOUND", `ไม่พบ repository ${repoFullName}`);
      }
      return repo;
    },

    async listBranches(_installationId: number, _repoFullName: string): Promise<Branch[]> {
      return options.branches ?? defaultBranches;
    },

    async validateBranch(
      _installationId: number,
      repoFullName: string,
      branchName: string,
    ): Promise<Branch> {
      const branches = options.branches ?? defaultBranches;
      const missing = options.missingBranches ?? [];
      if (missing.includes(branchName)) {
        throw new AppError(
          "INSTALLATION_NOT_FOUND",
          `ไม่พบ branch "${branchName}" ใน repository "${repoFullName}"`,
        );
      }
      const found = branches.find((b) => b.name === branchName);
      if (!found) {
        throw new AppError(
          "INSTALLATION_NOT_FOUND",
          `ไม่พบ branch "${branchName}" ใน repository "${repoFullName}"`,
        );
      }
      return found;
    },

    invalidateToken(installationId: number): void {
      invalidatedTokens.push(installationId);
    },
  };
}

export interface MockRegistryOptions extends MockGitHubOptions {
  /** apps ที่ registry คืน — default: 1 app */
  apps?: GitHubAppSummary[];
  /** webhook secret ต่อ app row ID — default: ทุก app ใช้ defaultWebhookSecret */
  webhookSecrets?: Record<string, string>;
  defaultWebhookSecret?: string;
  /** master key configure แล้วหรือยัง */
  ready?: boolean;
  /** getService/getServiceForInstallation คืน null (จำลอง app ไม่พร้อม) */
  serviceUnavailable?: boolean;
  /** getWebhookSecret โยน error (จำลอง decrypt fail) */
  webhookSecretError?: boolean;
}

export const MOCK_APP_ID = "01JBQZX0000000000000000000";

export function createMockRegistry(options: MockRegistryOptions = {}): GitHubAppRegistry & {
  service: ReturnType<typeof createMockGitHub>;
  invalidatedTokens: number[];
} {
  const service = createMockGitHub(options);
  const defaultApp: GitHubAppSummary = {
    id: MOCK_APP_ID,
    appId: 123456,
    slug: "test-app",
    name: "Test App",
    htmlUrl: "https://github.com/apps/test-app",
    ownerLogin: "test-org",
    createdAt: 1700000000000,
  };
  const apps = options.apps ?? [defaultApp];
  const ready = options.ready ?? true;

  return {
    service,
    invalidatedTokens: service.invalidatedTokens,

    isReady: () => ready,
    listApps: () => apps,
    getApp: (id: string) => apps.find((a) => a.id === id) ?? null,

    createManifest(name: string, organization?: string) {
      if (!ready) {
        throw new AppError("GITHUB_UNAVAILABLE", "Master key ยังไม่ได้ configure");
      }
      const action = organization
        ? `https://github.com/organizations/${organization}/settings/apps/new?state=mock-state`
        : "https://github.com/settings/apps/new?state=mock-state";
      return { action, manifest: JSON.stringify({ name }), state: "mock-state" };
    },

    async completeManifest(_code: string, state: string): Promise<GitHubAppSummary> {
      if (state !== "mock-state") {
        throw new AppError("VALIDATION_ERROR", "manifest state ไม่ถูกต้องหรือหมดอายุ");
      }
      return apps[0] ?? defaultApp;
    },

    deleteApp(id: string): void {
      if (!apps.some((a) => a.id === id)) {
        throw new AppError("INSTALLATION_NOT_FOUND", "ไม่พบ GitHub App นี้");
      }
    },

    getInstallUrl(id: string) {
      const app = apps.find((a) => a.id === id);
      return app ? `https://github.com/apps/${app.slug}/installations/new` : null;
    },

    async getService(appRowId: string): Promise<GitHubService | null> {
      if (options.serviceUnavailable) return null;
      return apps.some((a) => a.id === appRowId) ? service : null;
    },

    async getServiceForInstallation(_installationId: number): Promise<GitHubService | null> {
      if (options.serviceUnavailable) return null;
      return service;
    },

    async getWebhookSecret(appRowId: string): Promise<string | null> {
      if (options.webhookSecretError) {
        throw new Error("decrypt ไม่สำเร็จ (mock)");
      }
      if (options.webhookSecrets) {
        return options.webhookSecrets[appRowId] ?? null;
      }
      if (!apps.some((a) => a.id === appRowId)) return null;
      return options.defaultWebhookSecret ?? null;
    },

    invalidateToken(installationId: number): void {
      service.invalidateToken(installationId);
    },
  };
}

/** สร้าง HMAC-SHA256 signature สำหรับ webhook payload (ใช้ในเทสต์) */
export async function signWebhook(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}
