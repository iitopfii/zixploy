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

import { hasUpdate, latestStableTag, UPDATE_CHECK, ZIXPLOY_VERSION } from "@zixploy/shared";

export interface UpdateStatus {
  current: string;
  latest: string | null;
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

/**
 * ดึง tag ทั้งหมดของ image หนึ่งตัวจาก GHCR
 *
 * ใช้ control-api เป็นตัวแทน image ทั้งชุด — CI push ทั้งสาม image พร้อมกันด้วย tag
 * เดียวกันเสมอ จึงไม่ต้องถามครบทุกตัว (ถ้าถามครบก็เปลือง request สามเท่าโดยไม่ได้อะไร)
 */
async function fetchTags(image: string): Promise<string[]> {
  const tokenRes = await fetchWithTimeout(UPDATE_CHECK.tokenUrl(image));
  if (!tokenRes.ok) throw new Error(`ขอ token จาก registry ไม่สำเร็จ (${tokenRes.status})`);

  const tokenBody = (await tokenRes.json()) as { token?: string };
  if (!tokenBody.token) throw new Error("registry ไม่ส่ง token กลับมา");

  const tagsRes = await fetchWithTimeout(UPDATE_CHECK.tagsUrl(image), {
    headers: { Authorization: `Bearer ${tokenBody.token}`, Accept: "application/json" },
  });
  if (tagsRes.status === 404) {
    throw new Error("ยังไม่มี image เผยแพร่บน registry (หรือ package ยังเป็น private)");
  }
  if (!tagsRes.ok) throw new Error(`อ่าน tag จาก registry ไม่สำเร็จ (${tagsRes.status})`);

  const body = (await tagsRes.json()) as { tags?: string[] | null };
  return body.tags ?? [];
}

export async function checkForUpdate(force = false): Promise<UpdateStatus> {
  const now = Date.now();
  if (!force && cache && now - cache.checkedAt < UPDATE_CHECK.cacheTtlMs) return cache;

  // รันจากซอร์ส — ไม่ต้องยิง registry เลย เทียบ semver กับ "dev" ไม่ได้อยู่แล้ว
  if (ZIXPLOY_VERSION === "dev") {
    cache = {
      current: ZIXPLOY_VERSION,
      latest: null,
      updateAvailable: false,
      checkedAt: now,
      error: null,
    };
    return cache;
  }

  try {
    const tags = await fetchTags("control-api");
    const latest = latestStableTag(tags);
    cache = {
      current: ZIXPLOY_VERSION,
      latest,
      // ตรรกะเทียบ semver อยู่ใน shared ที่เดียว (เทสต์ครอบไว้แล้ว) ไม่เทียบ string ตรงนี้เอง
      updateAvailable: hasUpdate(ZIXPLOY_VERSION, latest),
      checkedAt: now,
      error: null,
    };
  } catch (err) {
    cache = {
      current: ZIXPLOY_VERSION,
      latest: null,
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
