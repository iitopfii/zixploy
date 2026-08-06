/**
 * GitHub HTTP client tests — path encoding, response validation, error mapping
 *
 * ใช้ mock fetch ฉีดเข้า GitHubHttpClient เพื่อทดสอบโดยไม่เรียก GitHub จริง
 * ตรวจสอบ:
 * - Path encoding (encodeURIComponent ป้องกัน path traversal)
 * - Response shape validation (required fields)
 * - JSON parse error → AppError (ไม่ใช่ SyntaxError)
 * - Oversized response → AppError (byte count ไม่ใช่ char count)
 * - HTTP error codes → AppError codes ที่ถูกต้อง
 * - Timeout / network error → AppError GITHUB_UNAVAILABLE
 */

import { describe, expect, test } from "bun:test";
import { AppError } from "@zixploy/shared";
import { GitHubHttpClient } from "../src/github/client";

// Helper: สร้าง client ที่ใช้ mock fetch
function makeClient(
  mockFetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  return new GitHubHttpClient(async () => "test-jwt-token", mockFetch as typeof fetch);
}

// Helper: สร้าง JSON response
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// --- Path encoding ---

describe("GitHubHttpClient — path encoding", () => {
  test("owner/repo ปกติ → path ถูกต้อง", async () => {
    let capturedUrl = "";
    const client = makeClient(async (url) => {
      capturedUrl = String(url);
      return jsonRes({
        id: 1,
        name: "my-app",
        full_name: "owner/my-app",
        private: false,
        default_branch: "main",
        description: null,
      });
    });
    await client.getRepo("token", "owner/my-app");
    expect(capturedUrl).toContain("/repos/owner/my-app");
  });

  test("owner/repo มี spaces → encoded เป็น %20", async () => {
    let capturedUrl = "";
    const client = makeClient(async (url) => {
      capturedUrl = String(url);
      return jsonRes({
        id: 2,
        name: "my app",
        full_name: "org name/my app",
        private: false,
        default_branch: "main",
        description: null,
      });
    });
    await client.getRepo("token", "org name/my app");
    expect(capturedUrl).toContain("/repos/org%20name/my%20app");
  });

  test("branch มี / → encoded เป็น %2F ใน URL path", async () => {
    let capturedUrl = "";
    const client = makeClient(async (url) => {
      capturedUrl = String(url);
      return jsonRes({ name: "feature/x", protected: false, commit: { sha: "a".repeat(40) } });
    });
    await client.getBranch("token", "owner/repo", "feature/x");
    // branch name "feature/x" ต้อง encode เป็น feature%2Fx ไม่ใช่ feature/x
    expect(capturedUrl).toContain("branches/feature%2Fx");
    // ตรวจว่าไม่มี unencoded slash หลัง "branches/"
    const branchPart = capturedUrl.split("/branches/")[1] ?? "";
    expect(branchPart).not.toContain("/");
  });

  test("branch ชื่อปกติ → path ถูกต้อง", async () => {
    let capturedUrl = "";
    const client = makeClient(async (url) => {
      capturedUrl = String(url);
      return jsonRes({ name: "main", protected: true, commit: { sha: "a".repeat(40) } });
    });
    await client.getBranch("token", "owner/repo", "main");
    expect(capturedUrl).toContain("/branches/main");
  });

  test("listRepoBranches → repo path encoded", async () => {
    let capturedUrl = "";
    const client = makeClient(async (url) => {
      capturedUrl = String(url);
      return jsonRes([]);
    });
    await client.listRepoBranches("token", "my org/my repo");
    expect(capturedUrl).toContain("/repos/my%20org/my%20repo/branches");
  });

  test("getRepo → repo path encoded", async () => {
    let capturedUrl = "";
    const client = makeClient(async (url) => {
      capturedUrl = String(url);
      return jsonRes({
        id: 3,
        name: "repo",
        full_name: "org/repo",
        private: false,
        default_branch: "main",
        description: null,
      });
    });
    await client.getRepo("token", "org/repo");
    expect(capturedUrl).toContain("/repos/org/repo");
  });
});

// --- HTTP error mapping ---

describe("GitHubHttpClient — HTTP error mapping", () => {
  test("404 → AppError INSTALLATION_NOT_FOUND", async () => {
    const client = makeClient(async () => new Response(null, { status: 404 }));
    await expect(client.getRepo("token", "owner/repo")).rejects.toMatchObject({
      code: "INSTALLATION_NOT_FOUND",
    });
    await expect(client.getBranch("token", "owner/repo", "main")).rejects.toMatchObject({
      code: "INSTALLATION_NOT_FOUND",
    });
  });

  test("401 → AppError GITHUB_UNAVAILABLE (ไม่ expose credential detail)", async () => {
    const client = makeClient(async () => new Response(null, { status: 401 }));
    // ใช้ try/catch เพื่อหลีกเลี่ยง union type จาก .catch() return
    let caughtErr: unknown;
    try {
      await client.getRepo("token", "owner/repo");
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeInstanceOf(AppError);
    const err = caughtErr as AppError;
    expect(err.code).toBe("GITHUB_UNAVAILABLE");
    // ตรวจว่า error message ไม่มี "token", "Bearer", หรือ credential value
    expect(err.message).not.toMatch(/token|bearer|jwt/i);
  });

  test("403 → AppError GITHUB_UNAVAILABLE", async () => {
    const client = makeClient(async () => new Response(null, { status: 403 }));
    await expect(client.getRepo("token", "owner/repo")).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });

  test("429 → AppError GITHUB_UNAVAILABLE", async () => {
    const client = makeClient(async () => new Response(null, { status: 429 }));
    await expect(client.getRepo("token", "owner/repo")).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });

  test("429 with retry-after header → message mentions retry-after", async () => {
    const client = makeClient(
      async () => new Response(null, { status: 429, headers: { "retry-after": "60" } }),
    );
    let caughtErr: unknown;
    try {
      await client.getRepo("token", "owner/repo");
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeInstanceOf(AppError);
    const err = caughtErr as AppError;
    expect(err.code).toBe("GITHUB_UNAVAILABLE");
    expect(err.message).toContain("60");
  });

  test("500 → AppError GITHUB_UNAVAILABLE", async () => {
    const client = makeClient(async () => new Response(null, { status: 500 }));
    await expect(client.getRepo("token", "owner/repo")).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });

  test("503 → AppError GITHUB_UNAVAILABLE", async () => {
    const client = makeClient(async () => new Response(null, { status: 503 }));
    await expect(client.getInstallation(12345)).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });

  test("network error → AppError GITHUB_UNAVAILABLE", async () => {
    const client = makeClient(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(client.getRepo("token", "owner/repo")).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });

  test("AbortError (timeout) → AppError GITHUB_UNAVAILABLE", async () => {
    const client = makeClient(async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    await expect(client.getRepo("token", "owner/repo")).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });
});

// --- JSON validation ---

describe("GitHubHttpClient — JSON parse + response validation", () => {
  test("malformed JSON → AppError GITHUB_UNAVAILABLE (ไม่ใช่ SyntaxError)", async () => {
    const client = makeClient(async () => new Response("not-json!!!", { status: 200 }));
    const err = await client.getRepo("token", "owner/repo").catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("GITHUB_UNAVAILABLE");
  });

  test("JSON เป็น array แทน object → AppError GITHUB_UNAVAILABLE", async () => {
    const client = makeClient(async () => new Response("[1,2,3]", { status: 200 }));
    await expect(client.getRepo("token", "owner/repo")).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });

  test("JSON ขาด required field (getRepo: missing full_name) → AppError GITHUB_UNAVAILABLE", async () => {
    const client = makeClient(async () =>
      jsonRes({ id: 1, name: "repo", private: false, default_branch: "main" }),
    ); // ขาด full_name
    await expect(client.getRepo("token", "owner/repo")).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });

  test("JSON ขาด required field (getBranch: missing name) → AppError GITHUB_UNAVAILABLE", async () => {
    const client = makeClient(async () =>
      jsonRes({ protected: false, commit: { sha: "a".repeat(40) } }),
    ); // ขาด name
    await expect(client.getBranch("token", "owner/repo", "main")).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });

  test("JSON ขาด commit.sha (getBranch) → AppError GITHUB_UNAVAILABLE", async () => {
    const client = makeClient(async () => jsonRes({ name: "main", protected: true, commit: {} }));
    await expect(client.getBranch("token", "owner/repo", "main")).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });

  test("JSON ขาด required field (getInstallation: missing account) → AppError GITHUB_UNAVAILABLE", async () => {
    const client = makeClient(async () => jsonRes({ id: 123, suspended_at: null })); // ขาด account
    await expect(client.getInstallation(123)).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });

  test("JSON ขาด required field (createInstallationToken: missing token) → AppError GITHUB_UNAVAILABLE", async () => {
    const client = makeClient(async () => jsonRes({ expires_at: "2099-01-01T00:00:00Z" })); // ขาด token
    await expect(client.createInstallationToken(123)).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });

  test("listInstallationRepos: repositories ไม่ใช่ array → AppError GITHUB_UNAVAILABLE", async () => {
    const client = makeClient(async () =>
      jsonRes({ repositories: "not-an-array", total_count: 0 }),
    );
    await expect(client.listInstallationRepos("token")).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });

  test("response ขนาดใหญ่กว่า MAX_BODY_BYTES (4MB) → AppError GITHUB_UNAVAILABLE", async () => {
    // สร้าง string ที่มี byte length > 4MB
    // ใช้ ASCII chars ดังนั้น 1 char = 1 byte
    const bigText = "x".repeat(4 * 1024 * 1024 + 1);
    const client = makeClient(async () => new Response(bigText, { status: 200 }));
    await expect(client.getRepo("token", "owner/repo")).rejects.toMatchObject({
      code: "GITHUB_UNAVAILABLE",
    });
  });
});

// --- getBranch ---

describe("GitHubHttpClient — getBranch", () => {
  test("branch มีอยู่ → คืน branch data พร้อม commit.sha", async () => {
    const sha = "a".repeat(40);
    const client = makeClient(async () =>
      jsonRes({ name: "main", protected: true, commit: { sha } }),
    );
    const branch = await client.getBranch("token", "owner/repo", "main");
    expect(branch.name).toBe("main");
    expect(branch.protected).toBe(true);
    expect(branch.commit.sha).toBe(sha);
  });

  test("branch ไม่มี (404) → AppError INSTALLATION_NOT_FOUND", async () => {
    const client = makeClient(async () => new Response(null, { status: 404 }));
    await expect(client.getBranch("token", "owner/repo", "nonexistent")).rejects.toMatchObject({
      code: "INSTALLATION_NOT_FOUND",
    });
  });

  test("branch ชื่อ develop → path encode ถูกต้อง", async () => {
    let capturedUrl = "";
    const client = makeClient(async (url) => {
      capturedUrl = String(url);
      return jsonRes({ name: "develop", protected: false, commit: { sha: "a".repeat(40) } });
    });
    await client.getBranch("token", "owner/repo", "develop");
    expect(capturedUrl).toContain("/branches/develop");
  });
});
