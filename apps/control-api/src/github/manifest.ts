/**
 * GitHub App Manifest flow — สร้าง GitHub App จากระบบเราเอง
 * https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 *
 * Flow:
 * 1. เรา build manifest JSON + สุ่ม state → browser POST form ไป GitHub
 * 2. Admin ยืนยันบน GitHub → GitHub สร้าง app → redirect กลับมาพร้อม code
 * 3. เรา exchange code ผ่าน POST /app-manifests/{code}/conversions
 *    → ได้ app_id, pem, webhook_secret, client_id, client_secret ครบในครั้งเดียว
 *
 * Code ใช้ได้ครั้งเดียวและหมดอายุใน 1 ชั่วโมง
 */

import { AppError } from "@zixploy/shared";

const GITHUB_API = "https://api.github.com";
const EXCHANGE_TIMEOUT_MS = 15_000;

export interface ManifestOptions {
  /** ชื่อ GitHub App (GitHub จำกัด 34 ตัวอักษร) */
  appName: string;
  /** Base URL ของระบบเรา (public URL ที่ GitHub เข้าถึงได้) */
  baseUrl: string;
  /** ULID ของ github_apps row — generate ก่อน เพื่อฝังใน webhook/setup URL */
  rowId: string;
  /** state token กัน CSRF ใน manifest redirect */
  state: string;
  /** สร้างใต้ organization แทน personal account */
  organization?: string;
}

export interface ManifestForm {
  /** URL ที่ browser ต้อง POST form ไป */
  action: string;
  /** JSON string สำหรับ field ชื่อ "manifest" */
  manifest: string;
}

/** สร้าง manifest form data สำหรับ browser submit ไป GitHub */
export function buildManifestForm(options: ManifestOptions): ManifestForm {
  const { appName, baseUrl, rowId, state, organization } = options;

  const manifest = {
    name: appName,
    url: baseUrl,
    hook_attributes: {
      url: `${baseUrl}/api/v1/github/webhooks/${rowId}`,
      active: true,
    },
    // GitHub redirect มาที่นี่พร้อม ?code=&state= หลัง admin ยืนยันสร้าง app
    redirect_url: `${baseUrl}/api/v1/github/apps/callback`,
    // หลัง install → GitHub ส่ง ?installation_id=&setup_action= มาที่นี่
    setup_url: `${baseUrl}/api/v1/github/apps/${rowId}/setup`,
    public: false,
    default_permissions: {
      contents: "read",
      metadata: "read",
    },
    // installation/installation_repositories events ส่งมาให้ app โดยอัตโนมัติ
    default_events: ["push"],
  };

  const action = organization
    ? `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new?state=${encodeURIComponent(state)}`
    : `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;

  return { action, manifest: JSON.stringify(manifest) };
}

/** ผลลัพธ์จาก manifest conversion — มี credentials ครบ */
export interface ManifestConversion {
  appId: number;
  slug: string;
  name: string;
  htmlUrl: string;
  ownerLogin: string | null;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  pem: string;
}

/**
 * Exchange manifest code → app credentials
 * POST /app-manifests/{code}/conversions (ไม่ต้อง auth — code คือ authorization)
 */
export async function exchangeManifestCode(
  code: string,
  fetchFn: typeof fetch = fetch,
): Promise<ManifestConversion> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchFn(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
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
    // code หมดอายุหรือใช้ไปแล้ว
    throw new AppError("VALIDATION_ERROR", "manifest code หมดอายุหรือถูกใช้ไปแล้ว — สร้าง app ใหม่");
  }
  if (!res.ok) {
    throw new AppError("GITHUB_UNAVAILABLE", `GitHub manifest conversion ตอบ ${res.status}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await res.text());
  } catch {
    throw new AppError("GITHUB_UNAVAILABLE", "manifest conversion response ไม่ใช่ JSON ที่ถูกต้อง");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AppError("GITHUB_UNAVAILABLE", "manifest conversion response ผิดรูปแบบ");
  }
  const obj = parsed as Record<string, unknown>;
  for (const field of [
    "id",
    "slug",
    "name",
    "html_url",
    "pem",
    "webhook_secret",
    "client_id",
    "client_secret",
  ]) {
    if (!(field in obj)) {
      throw new AppError("GITHUB_UNAVAILABLE", `manifest conversion response ขาด field '${field}'`);
    }
  }

  const owner = obj.owner as Record<string, unknown> | null | undefined;

  // ไม่ log pem/webhook_secret/client_secret — docs/threat-model.md
  return {
    appId: Number(obj.id),
    slug: String(obj.slug),
    name: String(obj.name),
    htmlUrl: String(obj.html_url),
    ownerLogin: owner && typeof owner.login === "string" ? owner.login : null,
    clientId: String(obj.client_id),
    clientSecret: String(obj.client_secret),
    webhookSecret: String(obj.webhook_secret),
    pem: String(obj.pem),
  };
}
