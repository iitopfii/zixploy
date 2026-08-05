import { readFileSync } from "node:fs";

/**
 * GitHub App configuration — อ่านจาก environment variables เท่านั้น
 * private key อยู่ในไฟล์แยก ไม่ใส่ใน env variable (docs/threat-model.md section 4)
 *
 * การ validate เกิด lazy (เมื่อ endpoint ถูกเรียก) ไม่ใช่ startup
 * ดังนั้น Phase 1 functionality ยังทำงานได้แม้ไม่ได้ตั้งค่า GitHub App
 */
export interface GitHubAppConfig {
  appId: string;
  appSlug: string;
  privateKey: string; // PEM raw content
  webhookSecret: string;
  callbackUrl: string;
}

/** null หมายถึง GitHub App ยังไม่ได้ configure — ไม่ใช่ error */
export function loadGitHubConfig(): GitHubAppConfig | null {
  const appId = process.env.ZIXPLOY_GITHUB_APP_ID;
  const appSlug = process.env.ZIXPLOY_GITHUB_APP_SLUG;
  const keyFile = process.env.ZIXPLOY_GITHUB_APP_PRIVATE_KEY_FILE;
  const webhookSecret = process.env.ZIXPLOY_GITHUB_WEBHOOK_SECRET;
  const callbackUrl =
    process.env.ZIXPLOY_GITHUB_CALLBACK_URL ?? "http://localhost:3001/api/v1/github/callback";

  if (!appId || !appSlug || !keyFile || !webhookSecret) {
    return null;
  }

  let privateKey: string;
  try {
    privateKey = readFileSync(keyFile, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`GitHub App private key ไม่สามารถอ่านได้จาก ${keyFile}: ${msg}`);
  }

  if (!privateKey.includes("-----BEGIN")) {
    throw new Error("GitHub App private key ไม่ใช่ PEM format");
  }

  return { appId, appSlug, privateKey, webhookSecret, callbackUrl };
}
