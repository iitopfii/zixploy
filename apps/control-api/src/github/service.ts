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
 *
 * Security:
 * - CryptoKey cache ใน factory closure — ไม่ re-import PEM ทุก JWT call
 * - Installation token cache ใน memory ≤ token lifetime − 5 min
 * - ไม่เก็บ token หรือ JWT ลง DB — docs/threat-model.md
 */

import { AppError } from "@zixploy/shared";
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
   * ใช้ GET /repos/{owner}/{repo}/branches/{branch} โดยตรง — รองรับ repo ที่มี >100 branches
   * โยน AppError("INSTALLATION_NOT_FOUND") ถ้า branch ไม่มีอยู่
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

  constructor(
    private readonly config: GitHubAppConfig,
    private readonly client: GitHubClient,
  ) {
    this.tokenCache = new InstallationTokenCache();
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

  /**
   * Direct branch lookup — GET /repos/{owner}/{repo}/branches/{branch}
   * รองรับ repo ที่มี >100 branches (ไม่ต้อง paginate ทุก branch)
   * GitHub ตอบ 404 ถ้า branch ไม่มีอยู่ → map เป็น INSTALLATION_NOT_FOUND
   */
  async validateBranch(
    installationId: number,
    repoFullName: string,
    branchName: string,
  ): Promise<Branch> {
    const token = await this.getInstallationToken(installationId);
    try {
      const data = await this.client.getBranch(token, repoFullName, branchName);
      return mapBranch(data);
    } catch (err) {
      if (err instanceof AppError && err.code === "INSTALLATION_NOT_FOUND") {
        // Re-throw with clearer message about the branch specifically
        throw new AppError(
          "INSTALLATION_NOT_FOUND",
          `ไม่พบ branch "${branchName}" ใน repository "${repoFullName}"`,
        );
      }
      throw err;
    }
  }

  invalidateToken(installationId: number): void {
    this.tokenCache.invalidate(installationId);
  }
}

/**
 * สร้าง RealGitHubService จาก config + inject getAppJwt ให้ client
 * แยก factory function ออกมาเพื่อให้ test inject mock client แทนได้
 *
 * Security:
 * - CryptoKey cache ใน closure — import PEM ครั้งเดียว ไม่ re-parse ทุก JWT call
 * - config.privateKey (PEM string) ไม่ถูกส่งออกจาก closure
 */
export async function createGitHubService(
  config: GitHubAppConfig,
  client?: GitHubClient,
): Promise<RealGitHubService> {
  if (client) {
    return new RealGitHubService(config, client);
  }
  // production path: cache CryptoKey ใน closure ป้องกัน re-import ซึ่ง expensive
  let cachedKey: CryptoKey | null = null;
  const getAppJwt = async (): Promise<string> => {
    if (!cachedKey) {
      cachedKey = await importRsaPrivateKey(config.privateKey);
    }
    return signGitHubJwt(config.appId, cachedKey);
  };
  const { GitHubHttpClient } = await import("./client");
  return new RealGitHubService(config, new GitHubHttpClient(getAppJwt));
}
