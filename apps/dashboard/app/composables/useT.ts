/**
 * แปลข้อความนอก <template> และนอก setup — ใช้ในฟังก์ชันธรรมดา (helper, event handler, ค่า computed)
 *
 * ใน template ใช้ `$t("ns.key")` ตรง ๆ ได้ · ที่อื่นเรียก `tr("ns.key", { name })`
 * ค่าที่คืนอ่าน locale แบบ reactive: เรียกใน template หรือ computed แล้วเปลี่ยนภาษาจะอัปเดตเอง
 *
 * ข้อความอยู่ใน i18n/locales/<th|en>/<ns>.json — ต้องมี key เดียวกันทั้งสองภาษา
 * อักขระพิเศษของ vue-i18n ในข้อความ: `{name}` คือตัวแปร, `|` คั่นรูปพหูพจน์,
 * ถ้าต้องการพิมพ์ `@ { } |` ตรง ๆ ให้เขียน `{'@'}` `{'{'}` `{'}'}` `{'|'}`
 */
export function tr(key: string, params?: Record<string, unknown>): string {
  return useNuxtApp().$i18n.t(key, params ?? {});
}

/** แปลแบบมีจำนวน — ข้อความอังกฤษเขียน "{n} file | {n} files", ไทยเขียนรูปเดียว */
export function trCount(key: string, n: number, params?: Record<string, unknown>): string {
  return useNuxtApp().$i18n.t(key, { n, ...params }, n);
}

/** มี key นี้ในภาษาปัจจุบันหรือไม่ — ใช้กับ key ที่ประกอบจากค่าของ API (เช่น สถานะ) */
export function hasMessage(key: string): boolean {
  return useNuxtApp().$i18n.te(key);
}

/** BCP 47 tag ของภาษาปัจจุบัน สำหรับ Intl / toLocaleString — "th-TH" หรือ "en-US" */
export function localeTag(): string {
  return useNuxtApp().$i18n.locale.value === "en" ? "en-US" : "th-TH";
}

/**
 * ข้อความ error จาก response ของ API (envelope `{ error: { message } }`)
 * API ตอบตามภาษาที่เลือกอยู่แล้ว — `fallbackKey` ใช้เมื่อ response ไม่มีข้อความ
 */
export function apiErrorMessage(error: unknown, fallbackKey: string): string {
  const body = (error as { value?: unknown } | null)?.value as
    | { error?: { message?: string } }
    | null
    | undefined;
  return body?.error?.message ?? tr(fallbackKey);
}
