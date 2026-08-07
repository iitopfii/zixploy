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
