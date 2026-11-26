/**
 * สองภาษา (0.1.28) — ไทย (ค่าเริ่มต้น) และอังกฤษ
 *
 * ข้อความที่ส่งถึงผู้ใช้จาก API เขียนสองภาษาคู่กันที่จุดที่สร้างข้อความ:
 *
 *   throw new AppError("PROJECT_NOT_FOUND", { th: "ไม่พบ project นี้", en: "Project not found" });
 *
 * แล้วเลือกภาษาตอนตอบ (plugins/error-handler.ts) จาก header `x-zixploy-locale`
 * หรือคุกกี้ `zx_locale` ที่ dashboard ตั้ง — ไม่มีทั้งคู่ = ไทย เหมือนก่อนมีฟีเจอร์นี้
 */
export const LOCALES = ["th", "en"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "th";

/** header ที่ dashboard ส่งมากับทุก request ของ API client */
export const LOCALE_HEADER = "x-zixploy-locale";

/** คุกกี้ภาษาที่ dashboard ตั้ง — ใช้กับ request ที่ตั้ง header เองไม่ได้ (EventSource, WebSocket, ลิงก์ดาวน์โหลด) */
export const LOCALE_COOKIE = "zx_locale";

export interface LocalizedText {
  th: string;
  en: string;
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** string ธรรมดา = ยังไม่ได้แปล ใช้ค่าเดิมทุกภาษา */
export function localize(text: string | LocalizedText, locale: Locale): string {
  return typeof text === "string" ? text : text[locale];
}

/**
 * ภาษาของ request — header ก่อน แล้วคุกกี้ แล้วค่าเริ่มต้น
 * ไม่อ่าน Accept-Language: client เดิม (curl, script) ที่ไม่ได้เลือกภาษาต้องได้ข้อความไทยเหมือนเดิม
 */
export function localeFromHeaders(headers: { get(name: string): string | null }): Locale {
  const fromHeader = headers.get(LOCALE_HEADER)?.trim().toLowerCase();
  if (isLocale(fromHeader)) return fromHeader;

  const cookieHeader = headers.get("cookie");
  if (cookieHeader) {
    for (const part of cookieHeader.split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0 && part.slice(0, eq).trim() === LOCALE_COOKIE) {
        const value = part
          .slice(eq + 1)
          .trim()
          .toLowerCase();
        if (isLocale(value)) return value;
      }
    }
  }
  return DEFAULT_LOCALE;
}

/**
 * Error สองภาษาสำหรับ validator ใน package นี้ที่ไม่รู้จัก error code ของ API
 * `message` เป็นภาษาไทยเสมอ (เหมือน AppError) — ผู้เรียกแปลงเป็น AppError ด้วย `errorText(err)`
 */
export class LocalizedError extends Error {
  readonly localized: LocalizedText;

  constructor(text: LocalizedText) {
    super(text.th);
    this.name = "LocalizedError";
    this.localized = text;
  }
}

/**
 * ข้อความของ error ใด ๆ ในรูปที่ส่งต่อให้ `new AppError(code, ...)` ได้ทันที
 * — error ที่มี `localized` ({ th, en }) คืนทั้งสองภาษา, Error ธรรมดาคืน message เดิม
 */
export function errorText(err: unknown, fallback: LocalizedText): string | LocalizedText {
  if (err instanceof Error) {
    const localized = (err as { localized?: LocalizedText | null }).localized;
    if (localized && typeof localized.th === "string" && typeof localized.en === "string") {
      return localized;
    }
    return err.message || fallback;
  }
  return fallback;
}
