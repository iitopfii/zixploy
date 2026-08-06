/**
 * Centralized secret redaction for build/log pipeline — docs/phase-04-environment.md M4
 *
 * buildRedactFn รวม:
 *   1. redactString() จาก @zixploy/shared (redact GitHub tokens, JWTs, bearer, credential URLs)
 *   2. Literal replacement ของแต่ละ env secret value (จาก injectEnvVars.secretValues)
 *
 * ค่าที่สั้นกว่า ENV_SECRET_MIN_REDACT_LENGTH ถูกกรองออก — ค่าสั้นมากเช่น "1" หรือ "on"
 * จะทำให้เกิด false positive กับ log content ปกติ
 *
 * buildkit.ts ไม่ redact เอง — ผู้เรียก (pipeline/build.ts) ต้องครอบ onLog ก่อนส่งไป
 * (ดู comment ใน buildkit.ts: "ผู้เรียก (M6 pipeline) ต้อง redactString() เองก่อน persist/log")
 */

import { ENV_SECRET_MIN_REDACT_LENGTH, REDACTED, redactString } from "@zixploy/shared";

/** Escape special regex metacharacters in a literal string */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * สร้าง redact function สำหรับครอบ onLog callback ใน build pipeline
 *
 * @param secretValues - ค่า is_secret=true จาก injectEnvVars.secretValues
 * @returns (line: string) => string — apply base redactString แล้วแทน secret values ด้วย [redacted]
 *
 * ลำดับการทำงาน:
 *   1. redactString() — ครอบ GitHub tokens, JWTs, bearer headers (existing patterns)
 *   2. literal match ของแต่ละ secret value — longest first เพื่อกัน partial overlap
 */
export function buildRedactFn(secretValues: string[]): (line: string) => string {
  // กรองค่าสั้น + sort longest-first (ป้องกัน substring overlap ทำให้ [redacted] ติดอยู่ใน pattern)
  const patterns = secretValues
    .filter((v) => v.length >= ENV_SECRET_MIN_REDACT_LENGTH)
    .sort((a, b) => b.length - a.length)
    .map((v) => new RegExp(escapeRegex(v), "g"));

  if (patterns.length === 0) {
    // ไม่มี secret values — ใช้ base redactString เท่านั้น (zero overhead)
    return redactString;
  }

  return (line: string): string => {
    let result = redactString(line);
    for (const re of patterns) {
      result = result.replace(re, REDACTED);
    }
    return result;
  };
}
