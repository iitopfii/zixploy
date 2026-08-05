/**
 * GitHub API client — typed interface + HTTP implementation
 *
 * Interface แยกจาก implementation เพื่อ inject mock ในเทสต์
 * Route modules depend on GitHubClient interface ไม่ใช่ class โดยตรง
 *
 * GitHub REST API v3: https://docs.github.com/en/rest
 * ทุก call ต้อง timeout และ map error ให้เป็น typed AppError
 */

import { AppError } from "@zixploy/shared";

/** Installation resource จาก GET /app/installations/{id} */
export interface GitHubInstallationData {
  id: number;
  account: {
    login: string;
    type: "User" | "Organization";
    avatar_url: string;
  };
  suspended_at: string | null;
}

/** Repository resource จาก GET /installation/repositories */
export interface GitHubRepositoryData {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  description: string | null;
}

/** Branch resource จาก GET /repos/{owner}/{repo}/branches */
export interface GitHubBranchData {
  name: string;
  protected: boolean;
}

/** Token response จาก POST /app/installations/{id}/access_tokens */
export interface GitHubAccessTokenData {
  token: string;
  expires_at: string; // ISO 8601
}

export interface ListReposOptions {
  page?: number;
  perPage?: number;
}

export interface ListBranchesOptions {
  page?: number;
  perPage?: number;
}

/**
 * Interface ที่ route modules ใช้ — ฉีด mock สำหรับเทสต์ได้
 * ทุก method โยน AppError("GITHUB_UNAVAILABLE") เมื่อ GitHub ไม่ตอบสนอง
 */
export interface GitHubClient {
  /** ดึงรายละเอียด installation (ใช้ App JWT) */
  getInstallation(installationId: number): Promise<GitHubInstallationData>;
  /** ขอ installation access token ใหม่ (ใช้ App JWT) */
  createInstallationToken(installationId: number): Promise<GitHubAccessTokenData>;
  /** List repositories ที่ installation เข้าถึงได้ */
  listInstallationRepos(
    token: string,
    options?: ListReposOptions,
  ): Promise<{ repositories: GitHubRepositoryData[]; total_count: number }>;
  /** ดึงข้อมูล repository เดียว (ตรวจสิทธิ์) */
  getRepo(token: string, repoFullName: string): Promise<GitHubRepositoryData>;
  /** List branches ของ repository */
  listRepoBranches(
    token: string,
    repoFullName: string,
    options?: ListBranchesOptions,
  ): Promise<GitHubBranchData[]>;
}

const GITHUB_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB ต่อ response

/**
 * HTTP implementation — ใช้ fetch ของ Bun ไม่มี external dependency
 * JWT ฉีดเข้ามาแทนที่จะสร้างเอง เพราะ JWT signing เป็น async และมี state
 */
export class GitHubHttpClient implements GitHubClient {
  constructor(private readonly getAppJwt: () => Promise<string>) {}

  private async appFetch(path: string): Promise<Response> {
    const jwt = await this.getAppJwt();
    return this.fetchWithTimeout(`${GITHUB_API}${path}`, {
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
  }

  private async tokenFetch(token: string, path: string): Promise<Response> {
    return this.fetchWithTimeout(`${GITHUB_API}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      return res;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AppError("GITHUB_UNAVAILABLE", "GitHub API ไม่ตอบสนองภายในเวลาที่กำหนด");
      }
      throw new AppError("GITHUB_UNAVAILABLE", "ติดต่อ GitHub API ไม่ได้");
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseJson<T>(res: Response, context: string): Promise<T> {
    if (res.status === 404) {
      throw new AppError("INSTALLATION_NOT_FOUND", `ไม่พบ resource: ${context}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new AppError("GITHUB_UNAVAILABLE", `GitHub ปฏิเสธ credential: ${context}`);
    }
    if (res.status === 429) {
      throw new AppError("GITHUB_UNAVAILABLE", "GitHub rate limit — ลองใหม่ภายหลัง");
    }
    if (!res.ok) {
      throw new AppError("GITHUB_UNAVAILABLE", `GitHub API ตอบ ${res.status}: ${context}`);
    }
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new AppError("GITHUB_UNAVAILABLE", `GitHub response ใหญ่เกิน: ${context}`);
    }
    return JSON.parse(text) as T;
  }

  async getInstallation(installationId: number): Promise<GitHubInstallationData> {
    const res = await this.appFetch(`/app/installations/${installationId}`);
    return this.parseJson<GitHubInstallationData>(res, `installation/${installationId}`);
  }

  async createInstallationToken(installationId: number): Promise<GitHubAccessTokenData> {
    const jwt = await this.getAppJwt();
    const res = await this.fetchWithTimeout(
      `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "content-length": "0",
        },
      },
    );
    return this.parseJson<GitHubAccessTokenData>(res, `access_tokens/${installationId}`);
  }

  async listInstallationRepos(
    token: string,
    options: ListReposOptions = {},
  ): Promise<{ repositories: GitHubRepositoryData[]; total_count: number }> {
    const { page = 1, perPage = 30 } = options;
    const res = await this.tokenFetch(
      token,
      `/installation/repositories?page=${page}&per_page=${perPage}`,
    );
    return this.parseJson<{ repositories: GitHubRepositoryData[]; total_count: number }>(
      res,
      "installation/repositories",
    );
  }

  async getRepo(token: string, repoFullName: string): Promise<GitHubRepositoryData> {
    const res = await this.tokenFetch(token, `/repos/${repoFullName}`);
    return this.parseJson<GitHubRepositoryData>(res, `repos/${repoFullName}`);
  }

  async listRepoBranches(
    token: string,
    repoFullName: string,
    options: ListBranchesOptions = {},
  ): Promise<GitHubBranchData[]> {
    const { page = 1, perPage = 100 } = options;
    const res = await this.tokenFetch(
      token,
      `/repos/${repoFullName}/branches?page=${page}&per_page=${perPage}`,
    );
    return this.parseJson<GitHubBranchData[]>(res, `repos/${repoFullName}/branches`);
  }
}
