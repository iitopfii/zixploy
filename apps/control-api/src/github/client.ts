/**
 * GitHub API client — typed interface + HTTP implementation
 *
 * Interface แยกจาก implementation เพื่อ inject mock ในเทสต์ได้
 * Route modules depend on GitHubClient interface ไม่ใช่ class โดยตรง
 *
 * GitHub REST API v3: https://docs.github.com/en/rest
 * ทุก call ต้อง timeout และ map error ให้เป็น typed AppError
 *
 * Security:
 * - ไม่ log Authorization header, JWT, หรือ access token ทั้งใน error message และ context
 * - Path segments encoded ด้วย encodeURIComponent ป้องกัน path traversal
 * - Response size ตรวจเป็น byte (Buffer.byteLength) ไม่ใช่ JS char count
 * - JSON.parse ครอบด้วย try-catch → AppError ไม่ให้ SyntaxError leak
 * - Response shape validation ป้องกัน runtime error จาก missing fields
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

/** Branch resource จาก GET /repos/{owner}/{repo}/branches/{branch} */
export interface GitHubBranchData {
  name: string;
  protected: boolean;
  /** ใช้ resolve commit ล่าสุดตอน manual deploy (Phase 3) — GitHub ส่งมาเสมอในทั้ง list และ single-branch response */
  commit: { sha: string };
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
  /**
   * ดึง branch เดียวโดยตรง — GET /repos/{owner}/{repo}/branches/{branch}
   * โยน AppError("INSTALLATION_NOT_FOUND") เมื่อ branch ไม่มีอยู่ (404)
   * เร็วกว่า listRepoBranches เพราะ single request และรองรับ repo ที่มี >100 branches
   */
  getBranch(token: string, repoFullName: string, branchName: string): Promise<GitHubBranchData>;
}

const GITHUB_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB ต่อ response

// --- Shape validation helpers ---

function assertObject(v: unknown, context: string): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new AppError(
      "GITHUB_UNAVAILABLE",
      `GitHub API response ผิดรูปแบบ (ไม่ใช่ object): ${context}`,
    );
  }
}

function assertFields(v: unknown, fields: string[], context: string): void {
  assertObject(v, context);
  for (const f of fields) {
    if (!(f in v)) {
      throw new AppError("GITHUB_UNAVAILABLE", `GitHub API response ขาด field '${f}': ${context}`);
    }
  }
}

function assertArray(v: unknown, context: string): asserts v is unknown[] {
  if (!Array.isArray(v)) {
    throw new AppError(
      "GITHUB_UNAVAILABLE",
      `GitHub API response ผิดรูปแบบ (ไม่ใช่ array): ${context}`,
    );
  }
}

/** ตรวจ shape ของ branch object เดียว: name, protected, commit.sha — ใช้ทั้ง single-branch และ list */
function assertBranchShape(v: unknown, context: string): void {
  assertFields(v, ["name", "protected", "commit"], context);
  assertFields((v as Record<string, unknown>).commit, ["sha"], `${context}.commit`);
}

function assertBranchArray(v: unknown, context: string): void {
  assertArray(v, context);
  for (let i = 0; i < v.length; i++) {
    assertBranchShape(v[i], `${context}[${i}]`);
  }
}

/**
 * HTTP implementation — ใช้ fetch ของ Bun ไม่มี external dependency
 * JWT ฉีดเข้ามาแทนที่จะสร้างเอง เพราะ JWT signing เป็น async และมี state
 *
 * fetchFn ฉีดได้สำหรับเทสต์ — production ใช้ global fetch
 */
export class GitHubHttpClient implements GitHubClient {
  constructor(
    private readonly getAppJwt: () => Promise<string>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Encode owner/repo path segments — ป้องกัน path traversal จาก repo names ที่มี special chars */
  private static repoPath(repoFullName: string): string {
    const slash = repoFullName.indexOf("/");
    if (slash === -1) return encodeURIComponent(repoFullName);
    return `${encodeURIComponent(repoFullName.slice(0, slash))}/${encodeURIComponent(repoFullName.slice(slash + 1))}`;
  }

  private async appFetch(path: string): Promise<Response> {
    const jwt = await this.getAppJwt();
    // ไม่ log jwt — docs/threat-model.md
    return this.fetchWithTimeout(`${GITHUB_API}${path}`, {
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
  }

  private async tokenFetch(token: string, path: string): Promise<Response> {
    // ไม่ log token — docs/threat-model.md
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
      const res = await this.fetchFn(url as Parameters<typeof fetch>[0], {
        ...init,
        signal: controller.signal,
      });
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

  private async parseJson<T>(
    res: Response,
    context: string,
    validate?: (v: unknown) => void,
  ): Promise<T> {
    if (res.status === 404) {
      throw new AppError("INSTALLATION_NOT_FOUND", `ไม่พบ resource: ${context}`);
    }
    if (res.status === 401 || res.status === 403) {
      // ไม่ใส่ credential detail ใน error message
      throw new AppError(
        "GITHUB_UNAVAILABLE",
        "GitHub ปฏิเสธ credential — ตรวจสอบ App configuration",
      );
    }
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const waitMsg = retryAfter ? ` (retry-after: ${retryAfter}s)` : "";
      throw new AppError("GITHUB_UNAVAILABLE", `GitHub rate limit — ลองใหม่ภายหลัง${waitMsg}`);
    }
    if (!res.ok) {
      throw new AppError("GITHUB_UNAVAILABLE", `GitHub API ตอบ ${res.status}: ${context}`);
    }

    const text = await res.text();
    // ตรวจเป็น byte ไม่ใช่ JS char count — multi-byte UTF-8 ทำให้ .length ต่ำกว่าจริง
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      throw new AppError("GITHUB_UNAVAILABLE", `GitHub response ใหญ่เกิน: ${context}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AppError("GITHUB_UNAVAILABLE", `GitHub API response ไม่ใช่ JSON ที่ถูกต้อง: ${context}`);
    }

    validate?.(parsed);
    return parsed as T;
  }

  async getInstallation(installationId: number): Promise<GitHubInstallationData> {
    const res = await this.appFetch(`/app/installations/${installationId}`);
    return this.parseJson<GitHubInstallationData>(res, `installation/${installationId}`, (v) => {
      assertFields(v, ["id", "account"], `installation/${installationId}`);
      assertFields(
        (v as Record<string, unknown>).account,
        ["login", "type", "avatar_url"],
        `installation.account/${installationId}`,
      );
    });
  }

  async createInstallationToken(installationId: number): Promise<GitHubAccessTokenData> {
    const jwt = await this.getAppJwt();
    // ไม่ log jwt — docs/threat-model.md
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
    return this.parseJson<GitHubAccessTokenData>(res, `access_tokens/${installationId}`, (v) =>
      assertFields(v, ["token", "expires_at"], `access_tokens/${installationId}`),
    );
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
      (v) => {
        assertFields(v, ["repositories", "total_count"], "installation/repositories");
        assertArray(
          (v as Record<string, unknown>).repositories,
          "installation/repositories.repositories",
        );
      },
    );
  }

  async getRepo(token: string, repoFullName: string): Promise<GitHubRepositoryData> {
    const encoded = GitHubHttpClient.repoPath(repoFullName);
    const res = await this.tokenFetch(token, `/repos/${encoded}`);
    return this.parseJson<GitHubRepositoryData>(res, `repos/${repoFullName}`, (v) =>
      assertFields(
        v,
        ["id", "name", "full_name", "private", "default_branch"],
        `repos/${repoFullName}`,
      ),
    );
  }

  async listRepoBranches(
    token: string,
    repoFullName: string,
    options: ListBranchesOptions = {},
  ): Promise<GitHubBranchData[]> {
    const { page = 1, perPage = 100 } = options;
    const encoded = GitHubHttpClient.repoPath(repoFullName);
    const res = await this.tokenFetch(
      token,
      `/repos/${encoded}/branches?page=${page}&per_page=${perPage}`,
    );
    return this.parseJson<GitHubBranchData[]>(res, `repos/${repoFullName}/branches`, (v) =>
      assertBranchArray(v, `repos/${repoFullName}/branches`),
    );
  }

  async getBranch(
    token: string,
    repoFullName: string,
    branchName: string,
  ): Promise<GitHubBranchData> {
    const encoded = `${GitHubHttpClient.repoPath(repoFullName)}/branches/${encodeURIComponent(branchName)}`;
    const res = await this.tokenFetch(token, `/repos/${encoded}`);
    return this.parseJson<GitHubBranchData>(
      res,
      `repos/${repoFullName}/branches/${branchName}`,
      (v) => assertBranchShape(v, `repos/${repoFullName}/branches/${branchName}`),
    );
  }
}
