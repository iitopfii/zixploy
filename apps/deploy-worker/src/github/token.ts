/**
 * Installation token minting — worker ฝั่งเดียว (ADR-0002: ไม่มี RPC ไป control-api)
 *
 * Flow: numeric installationId → lookup github_installations.github_app_id (แถว ULID ของเรา)
 * → lookup github_apps (app_id + pem_ciphertext) → decrypt PEM → sign App JWT
 * → POST /app/installations/{id}/access_tokens → cache แล้วคืน token
 *
 * CryptoKey cache ต่อ app row id (import PEM ครั้งเดียว เหมือน control-api's
 * createGitHubService factory) — installation token cache แยกอีกชั้นเพื่อไม่ต้อง
 * sign JWT ใหม่ทุกครั้งที่ clone (JWT อายุ 9 นาที, installation token อายุ 1 ชั่วโมง)
 */

import type { Database } from "bun:sqlite";
import { AppError } from "@zixploy/shared";
import { decryptEnvelope } from "./envelope";
import { importRsaPrivateKey, signGitHubJwt } from "./jwt";
import type { MasterKeys } from "./master-key";
import { InstallationTokenCache } from "./token-cache";

export interface MintedToken {
  token: string;
  expiresAt: Date;
}

interface InstallationAppRow {
  github_app_id: string | null;
}

interface GitHubAppRow {
  id: string;
  app_id: number;
  pem_ciphertext: Uint8Array;
}

const GITHUB_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;

const cryptoKeyCache = new Map<string, CryptoKey>();
const tokenCache = new InstallationTokenCache();

async function getSigningKey(masterKeys: MasterKeys, appRow: GitHubAppRow): Promise<CryptoKey> {
  const cached = cryptoKeyCache.get(appRow.id);
  if (cached) return cached;

  const pem = await decryptEnvelope(
    masterKeys,
    appRow.pem_ciphertext,
    `github_app:${appRow.id}:pem`,
  );
  const key = await importRsaPrivateKey(pem);
  cryptoKeyCache.set(appRow.id, key);
  return key;
}

async function fetchAccessToken(
  fetchFn: typeof fetch,
  jwt: string,
  installationId: number,
): Promise<{ token: string; expires_at: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchFn(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        // ไม่ log jwt — docs/threat-model.md
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-length": "0",
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new AppError("GITHUB_UNAVAILABLE", "GitHub API ไม่ตอบสนองภายในเวลาที่กำหนด");
    }
    throw new AppError("GITHUB_UNAVAILABLE", "ติดต่อ GitHub API ไม่ได้");
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) {
    throw new AppError("INSTALLATION_NOT_FOUND", `ไม่พบ installation ${installationId} บน GitHub`);
  }
  if (!res.ok) {
    throw new AppError("GITHUB_UNAVAILABLE", `GitHub access_tokens ตอบ ${res.status}`);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError("GITHUB_UNAVAILABLE", "access_tokens response ไม่ใช่ JSON ที่ถูกต้อง");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("token" in parsed) ||
    !("expires_at" in parsed) ||
    typeof (parsed as Record<string, unknown>).token !== "string" ||
    typeof (parsed as Record<string, unknown>).expires_at !== "string"
  ) {
    throw new AppError("GITHUB_UNAVAILABLE", "access_tokens response ขาด field ที่จำเป็น");
  }
  return parsed as { token: string; expires_at: string };
}

/**
 * Mint (หรือคืนจาก cache) installation token สำหรับ numeric installationId
 * โยน AppError("INSTALLATION_NOT_FOUND") ถ้าไม่พบ installation/app ใน DB ของเรา
 * โยน AppError("GITHUB_UNAVAILABLE") ถ้า master key ไม่พร้อม หรือ decrypt/GitHub call ล้มเหลว
 */
export async function mintInstallationToken(
  db: Database,
  masterKeys: MasterKeys | null,
  installationId: number,
  fetchFn: typeof fetch = fetch,
): Promise<MintedToken> {
  const cachedToken = tokenCache.get(installationId);
  if (cachedToken) {
    const expiresAt = tokenCache.getGithubExpiresAt(installationId);
    return { token: cachedToken, expiresAt: expiresAt ?? new Date(Date.now() + 55 * 60 * 1000) };
  }

  if (!masterKeys) {
    throw new AppError(
      "GITHUB_UNAVAILABLE",
      "Master key ยังไม่ได้ configure บน worker — ตั้งค่า ZIXPLOY_MASTER_KEY_FILE",
    );
  }

  const installRow = db
    .query<InstallationAppRow, [number]>(
      "SELECT github_app_id FROM github_installations WHERE installation_id = ?",
    )
    .get(installationId);
  if (!installRow?.github_app_id) {
    throw new AppError("INSTALLATION_NOT_FOUND", `ไม่พบ installation ${installationId} ใน DB`);
  }

  const appRow = db
    .query<GitHubAppRow, [string]>(
      "SELECT id, app_id, pem_ciphertext FROM github_apps WHERE id = ?",
    )
    .get(installRow.github_app_id);
  if (!appRow) {
    throw new AppError("INSTALLATION_NOT_FOUND", "ไม่พบ GitHub App ของ installation นี้");
  }

  const key = await getSigningKey(masterKeys, appRow);
  const jwt = await signGitHubJwt(String(appRow.app_id), key);
  const data = await fetchAccessToken(fetchFn, jwt, installationId);

  const expiresAt = new Date(data.expires_at);
  tokenCache.set(installationId, data.token, expiresAt);
  // ไม่ log token value — docs/threat-model.md
  return { token: data.token, expiresAt };
}

/** ใช้ตอน test teardown เพื่อไม่ให้ cache รั่วข้าม test case */
export function resetTokenCacheForTests(): void {
  tokenCache.invalidateAll();
  cryptoKeyCache.clear();
}
