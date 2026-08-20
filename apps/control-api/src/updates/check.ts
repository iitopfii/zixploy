/**
 * ตรวจเวอร์ชันใหม่จาก GHCR — Phase 12
 *
 * repo เป็น private จึงใช้ Releases API ไม่ได้ (ต้องมี token) แต่ **package บน GHCR
 * ตั้งเป็นสาธารณะแยกจาก repo ได้** จึงอ่าน tag list ได้โดยไม่ต้องยืนยันตัวตน
 * (registry บังคับให้มี bearer token เสมอแม้ public — ขอ anonymous token ก่อนหนึ่งครั้ง)
 *
 * fail-soft ทุกกรณี: เน็ตล่ม/registry ล่ม/rate limit → คืน null ไม่ throw
 * ตรวจ update ไม่ได้ไม่ใช่เหตุให้หน้า dashboard พัง
 */

import {
  hasUpdate,
  latestStableTag,
  SELF_UPDATE_DISABLED,
  UPDATE_CHECK,
  ZIXPLOY_VERSION,
} from "@zixploy/shared";

export interface UpdateStatus {
  current: string;
  latest: string | null;
  /**
   * วันที่ build ของ image เวอร์ชันล่าสุด (epoch ms) — UI แสดงคู่กับเลขเวอร์ชัน
   * เพื่อให้คนเห็นความผิดปกติเอง เช่น tag เลขสูงกว่าแต่ build เก่ากว่าที่รันอยู่
   * (เคยเกิดจริงจาก tag ค้างยุคตั้งเลขผิด) — null = หาไม่ได้ ไม่ถือเป็น error
   */
  latestPublishedAt: number | null;
  updateAvailable: boolean;
  /** เวลาที่ตรวจล่าสุด (epoch ms) — UI ใช้บอกว่าข้อมูลสดแค่ไหน */
  checkedAt: number;
  /** สาเหตุที่ตรวจไม่ได้ — null = ตรวจสำเร็จ */
  error: string | null;
}

/**
 * cache ในหน่วยความจำของ process
 *
 * ไม่เก็บลง DB โดยตั้งใจ: ค่านี้เป็นข้อมูลชั่วคราวที่ derive ใหม่ได้เสมอ และการรีสตาร์ท
 * (ซึ่งเกิดทุกครั้งที่อัปเดต) ควรตรวจใหม่อยู่แล้ว ไม่ควรอ่านค่าค้างจากเวอร์ชันก่อน
 */
let cache: UpdateStatus | null = null;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_CHECK.timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** ขอ anonymous bearer token — ใช้ซ้ำได้ทั้ง tags/manifest/blob ในรอบตรวจเดียวกัน */
async function fetchAnonymousToken(image: string): Promise<string> {
  const tokenRes = await fetchWithTimeout(UPDATE_CHECK.tokenUrl(image));
  if (!tokenRes.ok) throw new Error(`ขอ token จาก registry ไม่สำเร็จ (${tokenRes.status})`);

  const tokenBody = (await tokenRes.json()) as { token?: string };
  if (!tokenBody.token) throw new Error("registry ไม่ส่ง token กลับมา");
  return tokenBody.token;
}

/**
 * ดึง tag ทั้งหมดของ image หนึ่งตัวจาก GHCR
 *
 * ใช้ control-api เป็นตัวแทน image ทั้งชุด — CI push ทั้งสาม image พร้อมกันด้วย tag
 * เดียวกันเสมอ จึงไม่ต้องถามครบทุกตัว (ถ้าถามครบก็เปลือง request สามเท่าโดยไม่ได้อะไร)
 */
async function fetchTags(image: string, token: string): Promise<string[]> {
  const tagsRes = await fetchWithTimeout(UPDATE_CHECK.tagsUrl(image), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (tagsRes.status === 404) {
    throw new Error("ยังไม่มี image เผยแพร่บน registry (หรือ package ยังเป็น private)");
  }
  if (!tagsRes.ok) throw new Error(`อ่าน tag จาก registry ไม่สำเร็จ (${tagsRes.status})`);

  const body = (await tagsRes.json()) as { tags?: string[] | null };
  return body.tags ?? [];
}

// ---------------------------------------------------------------------------
// วันที่ build ของ image — manifest → config blob → field `created`
// ---------------------------------------------------------------------------

/**
 * รับได้ทั้ง index (multi-arch) และ manifest เดี่ยว — registry เลือกส่งตามที่มีจริง
 * ไม่ใช่ตามที่เราขอ จึงต้อง Accept ครบทุกแบบแล้วมาแยกเอาจากโครงสร้าง response
 */
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/**
 * ถ้า response เป็น index/manifest list → digest ของ manifest ที่ควรตามต่อ
 * คืน null เมื่อเป็น manifest เดี่ยว (ไม่มี manifests[]) หรือหา entry ที่ใช้ได้ไม่เจอ
 *
 * เลือก linux ตัวแรกพอ — ทุก arch ถูก build จาก commit เดียวกัน วันที่จึงใกล้กันมาก
 * ข้าม architecture "unknown" เพราะเป็น attestation ของ buildkit ไม่ใช่ image จริง
 */
export function pickLinuxManifestDigest(json: unknown): string | null {
  const manifests = (json as { manifests?: unknown })?.manifests;
  if (!Array.isArray(manifests)) return null;

  for (const entry of manifests) {
    const m = entry as {
      digest?: unknown;
      platform?: { os?: unknown; architecture?: unknown };
    } | null;
    if (m?.platform?.os !== "linux" || m.platform.architecture === "unknown") continue;
    if (typeof m.digest === "string" && m.digest) return m.digest;
  }
  return null;
}

/** digest ของ config blob จาก manifest เดี่ยว — null เมื่อโครงสร้างไม่ตรงที่คาด */
export function extractConfigDigest(json: unknown): string | null {
  const digest = (json as { config?: { digest?: unknown } })?.config?.digest;
  return typeof digest === "string" && digest ? digest : null;
}

/** field `created` (ISO timestamp) ใน config blob → epoch ms, null เมื่อไม่มี/parse ไม่ได้ */
export function extractCreatedMs(json: unknown): number | null {
  const created = (json as { created?: unknown })?.created;
  if (typeof created !== "string") return null;
  const ms = Date.parse(created);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * วันที่ build ของ image tag หนึ่ง — fail-soft ทั้งก้อน: พังตรงไหนก็คืน null
 * วันที่เป็นข้อมูลเสริมช่วยคนตัดสินใจ ไม่คุ้มให้การตรวจ update ทั้งรอบล้มตามมัน
 */
async function fetchPublishedAt(image: string, tag: string, token: string): Promise<number | null> {
  try {
    const headers = { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT };

    const res = await fetchWithTimeout(UPDATE_CHECK.manifestUrl(image, tag), { headers });
    if (!res.ok) return null;
    let manifest: unknown = await res.json();

    // multi-arch: ตามต่อไปยัง manifest ของ platform จริงก่อนถึงจะเจอ config
    const platformDigest = pickLinuxManifestDigest(manifest);
    if (platformDigest) {
      const platformRes = await fetchWithTimeout(UPDATE_CHECK.manifestUrl(image, platformDigest), {
        headers,
      });
      if (!platformRes.ok) return null;
      manifest = await platformRes.json();
    }

    const configDigest = extractConfigDigest(manifest);
    if (!configDigest) return null;

    const blobRes = await fetchWithTimeout(UPDATE_CHECK.blobUrl(image, configDigest), { headers });
    if (!blobRes.ok) return null;
    return extractCreatedMs(await blobRes.json());
  } catch {
    return null;
  }
}

export async function checkForUpdate(force = false): Promise<UpdateStatus> {
  const now = Date.now();
  if (!force && cache && now - cache.checkedAt < UPDATE_CHECK.cacheTtlMs) return cache;

  // รันจากซอร์ส (dev) หรือ deployment ที่ปิด self-update ไว้ตรง ๆ (build จาก source โดยไม่มี
  // image tag ให้ pull) — ทั้งคู่ไม่ต้องยิง registry เลย
  if (ZIXPLOY_VERSION === "dev" || SELF_UPDATE_DISABLED) {
    cache = {
      current: ZIXPLOY_VERSION,
      latest: null,
      latestPublishedAt: null,
      updateAvailable: false,
      checkedAt: now,
      error: null,
    };
    return cache;
  }

  try {
    const token = await fetchAnonymousToken("control-api");
    const tags = await fetchTags("control-api", token);
    const latest = latestStableTag(tags);
    cache = {
      current: ZIXPLOY_VERSION,
      latest,
      latestPublishedAt: latest ? await fetchPublishedAt("control-api", latest, token) : null,
      // ตรรกะเทียบ semver อยู่ใน shared ที่เดียว (เทสต์ครอบไว้แล้ว) ไม่เทียบ string ตรงนี้เอง
      updateAvailable: hasUpdate(ZIXPLOY_VERSION, latest),
      checkedAt: now,
      error: null,
    };
  } catch (err) {
    cache = {
      current: ZIXPLOY_VERSION,
      latest: null,
      latestPublishedAt: null,
      updateAvailable: false,
      checkedAt: now,
      error: err instanceof Error ? err.message : "ตรวจเวอร์ชันไม่สำเร็จ",
    };
  }
  return cache;
}

/** ล้าง cache — ใช้หลังสั่ง update เพื่อให้ UI เห็นสถานะใหม่ทันทีที่กลับมา */
export function clearUpdateCache(): void {
  cache = null;
}
