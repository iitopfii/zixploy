/**
 * Version + registry — Phase 12 (installer และ self-update)
 *
 * เวอร์ชันที่รันอยู่ถูกฉีดผ่าน env ตอน start ไม่ได้ hardcode ไว้ในโค้ด:
 * install.sh และตัว update เขียน ZIXPLOY_VERSION ลง .env แล้ว compose ส่งต่อเข้า container
 * โค้ดชุดเดียวจึงรันได้ทุกเวอร์ชันโดยไม่ต้อง rebuild เพื่อเปลี่ยนเลข
 *
 * "dev" = รันจากซอร์สในเครื่อง (ไม่ได้ติดตั้งผ่าน installer) — ตัวตรวจ update จะข้ามไป
 * เพราะเทียบ semver กับ "dev" ไม่ได้ และคนที่รันจากซอร์สย่อมไม่อยากให้ระบบมาแทน container ให้
 */
export const ZIXPLOY_VERSION: string = process.env.ZIXPLOY_VERSION?.trim() || "dev";

export const IS_DEV_BUILD = ZIXPLOY_VERSION === "dev";

/**
 * ปิดการเช็ค/สั่งอัปเดตผ่านหน้าเว็บ แยกจาก IS_DEV_BUILD โดยตั้งใจ — ใช้กับ deployment ที่
 * build จาก source ตรง ๆ ผ่าน `docker compose build` (docker-compose ใช้ `build:` ไม่ใช่
 * `image:` ที่มี tag ให้ pull) กรณีนี้ ZIXPLOY_VERSION ตั้งเป็นเลขรุ่นจริงได้ตามปกติเพื่อโชว์
 * ใน UI (ไม่ใช่ "dev") แต่ self-update flow (docker compose pull) ใช้ไม่ได้จริงเพราะไม่มี
 * image tag ให้ pull — ผู้ดูแลต้อง redeploy จาก source เอง ไม่ใช่กดปุ่มในหน้าเว็บ
 */
export const SELF_UPDATE_DISABLED: boolean = process.env.ZIXPLOY_DISABLE_SELF_UPDATE === "true";

/** GHCR namespace ที่ CI push image ไป — image name = `${REGISTRY_NAMESPACE}-${service}` */
export const REGISTRY_NAMESPACE = "ghcr.io/iitopfii/zixploy";

export const SERVICE_IMAGES = ["control-api", "deploy-worker", "dashboard"] as const;

/**
 * ตรวจเวอร์ชันใหม่จาก tag list ของ GHCR โดยตรง
 *
 * ใช้ registry API แทน GitHub Releases API เพราะ repo เป็น private — Releases API
 * ต้องใช้ token แต่ **package บน GHCR ตั้งเป็นสาธารณะแยกจาก repo ได้** จึงอ่าน tag
 * ได้โดยไม่ต้องยืนยันตัวตน (ขอ anonymous bearer token จาก /token ก่อนหนึ่งครั้ง)
 *
 * override ด้วย ZIXPLOY_UPDATE_MANIFEST_URL ได้ถ้าภายหลังอยาก self-host manifest เอง
 */
export const UPDATE_CHECK = {
  tokenUrl: (image: string) =>
    `https://ghcr.io/token?scope=${encodeURIComponent(`repository:iitopfii/zixploy-${image}:pull`)}&service=ghcr.io`,
  tagsUrl: (image: string) => `https://ghcr.io/v2/iitopfii/zixploy-${image}/tags/list`,
  /** ถามซ้ำถี่กว่านี้ไม่มีประโยชน์ — release ไม่ได้ออกทุกนาที และ registry มี rate limit */
  cacheTtlMs: 30 * 60 * 1000,
  timeoutMs: 8_000,
} as const;

// ---------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** pre-release เช่น "rc.1" — undefined = release ปกติ */
  pre?: string;
}

/** "v1.2.3" / "1.2.3-rc.1" → SemVer, คืน null ถ้าไม่ใช่รูปแบบ semver */
export function parseSemVer(raw: string): SemVer | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] ? { pre: match[4] } : {}),
  };
}

/**
 * เทียบเวอร์ชัน: คืน >0 เมื่อ a ใหม่กว่า b, <0 เมื่อเก่ากว่า, 0 เมื่อเท่ากัน
 *
 * pre-release ถือว่า "เก่ากว่า" release เลขเดียวกันเสมอ (1.0.0-rc.1 < 1.0.0)
 * ตามข้อกำหนดของ semver — ไม่งั้นคนที่รัน 1.0.0 จะถูกชวนให้ downgrade ไป rc
 */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre && !b.pre) return -1;
  if (!a.pre && b.pre) return 1;
  if (a.pre && b.pre) return a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0;
  return 0;
}

/**
 * หาเวอร์ชันใหม่ที่สุดจากรายการ tag ที่ registry คืนมา
 *
 * ข้าม tag ที่ไม่ใช่ semver ("latest", "main", sha) และข้าม pre-release โดย default
 * — คนที่ติดตั้งผ่าน installer ควรได้ release ที่นิ่งแล้วเท่านั้น
 */
export function latestStableTag(tags: string[]): string | null {
  let best: { tag: string; ver: SemVer } | null = null;
  for (const tag of tags) {
    const ver = parseSemVer(tag);
    if (!ver || ver.pre) continue;
    if (!best || compareSemVer(ver, best.ver) > 0) best = { tag, ver };
  }
  return best?.tag ?? null;
}

/** มีเวอร์ชันใหม่กว่าที่รันอยู่ไหม — false เสมอเมื่อรันจากซอร์ส (dev) */
export function hasUpdate(current: string, latest: string | null): boolean {
  if (!latest || current === "dev") return false;
  const a = parseSemVer(current);
  const b = parseSemVer(latest);
  if (!a || !b) return false;
  return compareSemVer(b, a) > 0;
}
