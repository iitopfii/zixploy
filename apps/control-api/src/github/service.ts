/**
 * GitHubService — orchestration layer สำหรับ GitHub App integration
 *
 * Route modules depend on interface GitHubService ไม่ใช่ implementation โดยตรง
 * เพื่อให้ inject mock ในเทสต์ได้โดยไม่ต้องเรียก GitHub จริง
 *
 * Flow:
 * 1. Route เรียก GitHubService method
 * 2. Service ตรวจ token cache ก่อน
 * 3. ถ้าไม่มี: sign App JWT → POST access_tokens → cache token
 * 4. ใช้ token เรียก GitHub API
 */

import type {
  GitHubBranchData,
  GitHubClient,
  GitHubInstallationData,
  GitHubRepositoryData,
} from "./client";
import type { GitHubAppConfig } from "./config";
import { importRsaPrivateKey, signGitHubJwt } from "./jwt";
import { InstallationTokenCache } from "./token-cache";

/** Installation object ที่ routes ส่งออก */
export interface Installation {
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  accountAvatarUrl: string;
  suspended: boolean;
}

/** Repository object ที่ routes ส่งออก */
export interface Repository {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
}

/** Branch object ที่ routes ส่งออก */
export interface Branch {
  name: string;
  protected: boolean;
}

export interface ListReposResult {
  items: Repository[];
  totalCount: number;
  page: number;
  perPage: number;
}

export interface GitHubService {
  /** URL หน้า install GitHub App — redirect ผู้ใช้ไปที่นี่ */
  getInstallUrl(): string;
  /** ดึงและแปลง installation data จาก GitHub (ใช้ใน callback) */
  fetchInstallation(installationId: number): Promise<Installation>;
  /** List repositories ที่ installation เข้าถึงได้ (live จาก GitHub API) */
  listRepos(
    installationId: number,
    options?: { page?: number; perPage?: number },
  ): Promise<ListReposResult>;
  /**
   * Validate ว่า installation สามารถเข้าถึง repository นี้ได้จริง
   * โยน AppError("INSTALLATION_NOT_FOUND") ถ้าไม่มีสิทธิ์
   */
  validateRepo(installationId: number, repoFullName: string): Promise<Repository>;
  /** List branches (live) */
  listBranches(
    installationId: number,
    repoFullName: string,
    options?: { page?: number; perPage?: number },
  ): Promise<Branch[]>;
  /**
   * Validate ว่า branch มีอยู่จริงใน repository
   * คืน branch ถ้าเจอ; โยน AppError("INSTALLATION_NOT_FOUND") ถ้าไม่เจอ
   */
  validateBranch(installationId: number, repoFullName: string, branchName: string): Promise<Branch>;
  /** Invalidate cached token เมื่อ installation ถูก suspend/delete */
  invalidateToken(installationId: number): void;
}

function mapInstallation(data: GitHubInstallationData): Installation {
  return {
    installationId: data.id,
    accountLogin: data.account.login,
    accountType: data.account.type,
    accountAvatarUrl: data.account.avatar_url,
    suspended: data.suspended_at !== null,
  };
}

function mapRepository(data: GitHubRepositoryData): Repository {
  return {
    id: data.id,
    name: data.name,
    fullName: data.full_name,
    private: data.private,
    defaultBranch: data.default_branch,
    description: data.description,
  };
}

function mapBranch(data: GitHubBranchData): Branch {
  return {
    name: data.name,
    protected: data.protected,
  };
}

export class RealGitHubService implements GitHubService {
  private readonly tokenCache: InstallationTokenCache;
  private cryptoKey: CryptoKey | null = null;

  constructor(
    private readonly config: GitHubAppConfig,
    private readonly client: GitHubClient,
  ) {
    this.tokenCache = new InstallationTokenCache();
  }

  /** Lazy import private key — มี error message ชัดเจนถ้า PEM ผิด */
  private async getPrivateKey(): Promise<CryptoKey> {
    if (!this.cryptoKey) {
      const { importRsaPrivateKey: importKey } = await import("./jwt");
      this.cryptoKey = await importKey(this.config.privateKey);
    }
    return this.cryptoKey;
  }

  private async makeAppJwt(): Promise<string> {
    const key = await this.getPrivateKey();
    return signGitHubJwt(this.config.appId, key);
  }

  private async getInstallationToken(installationId: number): Promise<string> {
    const cached = this.tokenCache.get(installationId);
    if (cached) return cached;

    const tokenData = await this.client.createInstallationToken(installationId);
    const expiresAt = new Date(tokenData.expires_at);
    this.tokenCache.set(installationId, tokenData.token, expiresAt);
    // ไม่ log token value — docs/threat-model.md
    return tokenData.token;
  }

  getInstallUrl(): string {
    return `https://github.com/apps/${this.config.appSlug}/installations/new`;
  }

  async fetchInstallation(installationId: number): Promise<Installation> {
    const data = await this.client.getInstallation(installationId);
    return mapInstallation(data);
  }

  async listRepos(
    installationId: number,
    options: { page?: number; perPage?: number } = {},
  ): Promise<ListReposResult> {
    const token = await this.getInstallationToken(installationId);
    const { page = 1, perPage = 30 } = options;
    const result = await this.client.listInstallationRepos(token, { page, perPage });
    return {
      items: result.repositories.map(mapRepository),
      totalCount: result.total_count,
      page,
      perPage,
    };
  }

  async validateRepo(installationId: number, repoFullName: string): Promise<Repository> {
    const token = await this.getInstallationToken(installationId);
    const data = await this.client.getRepo(token, repoFullName);
    return mapRepository(data);
  }

  async listBranches(
    installationId: number,
    repoFullName: string,
    options: { page?: number; perPage?: number } = {},
  ): Promise<Branch[]> {
    const token = await this.getInstallationToken(installationId);
    const { page = 1, perPage = 100 } = options;
    const branches = await this.client.listRepoBranches(token, repoFullName, { page, perPage });
    return branches.map(mapBranch);
  }

  async validateBranch(
    installationId: number,
    repoFullName: string,
    branchName: string,
  ): Promise<Branch> {
    const branches = await this.listBranches(installationId, repoFullName);
    const found = branches.find((b) => b.name === branchName);
    if (!found) {
      const { AppError } = await import("@zixploy/shared");
      throw new AppError(
        "INSTALLATION_NOT_FOUND",
        `ไม่พบ branch "${branchName}" ใน repository "${repoFullName}"`,
      );
    }
    return found;
  }

  invalidateToken(installationId: number): void {
    this.tokenCache.invalidate(installationId);
  }
}

/**
 * สร้าง RealGitHubService จาก config + inject getAppJwt ให้ client
 * แยก factory function ออกมาเพื่อให้ test inject mock client แทนได้
 */
export async function createGitHubService(
  config: GitHubAppConfig,
  client?: GitHubClient,
): Promise<RealGitHubService> {
  if (client) {
    return new RealGitHubService(config, client);
  }
  // production path: สร้าง HTTP client จริง
  const { GitHubHttpClient } = await import("./client");
  const service = new RealGitHubService(
    config,
    new GitHubHttpClient(async () => {
      const key = await importRsaPrivateKey(config.privateKey);
      return signGitHubJwt(config.appId, key);
    }),
  );
  return service;
}
