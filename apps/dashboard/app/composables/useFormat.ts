/**
 * Formatting helper ที่ใช้ร่วมกันหลายหน้า — auto-import โดย Nuxt
 *
 * ทุกฟังก์ชันรับ epoch millis (รูปแบบเดียวกับที่ API คืนทุก timestamp)
 */

const RELATIVE_STEPS: Array<[limitSec: number, divisor: number, unit: string]> = [
  [60, 1, "วินาที"],
  [3600, 60, "นาที"],
  [86400, 3600, "ชั่วโมง"],
  [2592000, 86400, "วัน"],
  [31536000, 2592000, "เดือน"],
  [Number.POSITIVE_INFINITY, 31536000, "ปี"],
];

/** "3 นาทีที่แล้ว" / "เมื่อครู่" — คืน "—" ถ้าไม่มีค่า */
export function timeAgo(ms: number | null | undefined): string {
  if (!ms) return "—";
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec < 10) return "เมื่อครู่";
  if (diffSec < 0) return "อีกสักครู่";

  for (const [limit, divisor, unit] of RELATIVE_STEPS) {
    if (diffSec < limit) return `${Math.floor(diffSec / divisor)} ${unit}ที่แล้ว`;
  }
  return "—";
}

/** วันเวลาแบบเต็มสำหรับ tooltip — ใช้ locale ไทยพร้อมเวลา */
export function fullDateTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** ตัด commit SHA เหลือ 7 ตัวแบบ git */
export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "—";
}

/** ช่วงเวลาเป็นข้อความสั้น เช่น "1 น. 24 ว." — ใช้กับ build duration */
export function duration(fromMs: number | null | undefined, toMs?: number | null): string {
  if (!fromMs) return "—";
  const totalSec = Math.max(0, Math.round(((toMs ?? Date.now()) - fromMs) / 1000));
  if (totalSec < 60) return `${totalSec} ว.`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec ? `${min} น. ${sec} ว.` : `${min} น.`;
  return `${Math.floor(min / 60)} ชม. ${min % 60} น.`;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * ไบต์เป็นข้อความอ่านง่าย ฐาน 1024 — "1.5 GB", "820 MB"
 *
 * ทศนิยม 1 ตำแหน่งเฉพาะเมื่อ < 10 (เช่น 1.5 GB) ตั้งแต่ 10 ขึ้นไปปัดเต็ม (เช่น 128 MB)
 * — เลข 3 หลักพร้อมทศนิยมยาวเกินไปในตารางที่ความกว้างจำกัด
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  if (bytes <= 0) return "0 B";

  const exponent = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  const decimals = value < 10 && exponent > 0 ? 1 : 0;
  return `${value.toFixed(decimals)} ${BYTE_UNITS[exponent]}`;
}

/** เปอร์เซ็นต์แบบสั้น — ทศนิยม 1 ตำแหน่งเมื่อ < 10 */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

/** สัดส่วน used/total เป็น % — คืน 0 เมื่อ total ไม่ถูกต้อง (กันหารศูนย์) */
export function ratioPercent(used: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

/** เวลาแบบสั้นสำหรับแกน X ของกราฟ — "14:05" */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
}

/**
 * tone ตามระดับการใช้งาน — ใช้ทั้งสีกราฟและสีตัวเลข
 * เกณฑ์: < 70% ปกติ, 70-89% เริ่มตึง, >= 90% วิกฤต
 */
export function usageTone(percent: number): "ok" | "warn" | "bad" {
  if (percent >= 90) return "bad";
  if (percent >= 70) return "warn";
  return "ok";
}

/** คำอธิบายสถานะ project เป็นภาษาไทย — ใช้กับ badge ทุกที่ให้ตรงกัน */
export const PROJECT_STATUS_LABEL: Record<string, string> = {
  new: "ยังไม่ deploy",
  running: "ทำงานอยู่",
  deploying: "กำลัง deploy",
  failed: "ล้มเหลว",
  stopped: "หยุดแล้ว",
};

export function projectStatusLabel(status: string): string {
  return PROJECT_STATUS_LABEL[status] ?? status;
}

/**
 * สถานะของ deployment (การ build ครั้งหนึ่ง) — คนละชุดกับสถานะ project
 * project บอกว่า "แอปให้บริการอยู่ไหม" ส่วนอันนี้บอกว่า "build ไปถึงขั้นไหน"
 */
export const DEPLOYMENT_STATUS_LABEL: Record<string, string> = {
  queued: "เข้าคิว",
  cloning: "ดึงโค้ด",
  building: "กำลัง build",
  starting: "กำลังเริ่ม",
  health_checking: "ตรวจสุขภาพ",
  activating: "สลับ traffic",
  succeeded: "สำเร็จ",
  failed: "ล้มเหลว",
  cancelled: "ยกเลิกแล้ว",
};

export function deploymentStatusLabel(status: string): string {
  return DEPLOYMENT_STATUS_LABEL[status] ?? status;
}
