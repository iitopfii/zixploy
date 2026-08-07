/**
 * แยก label string จาก `docker ps --format "{{json .}}"`
 *
 * Docker ยัด label ทั้งหมดมาเป็น string เดียวคั่นด้วย comma ("k=v,k2=v2") ไม่ใช่ object
 * (ต่างจาก `docker inspect` ที่ให้ Config.Labels เป็น object จริง)
 */

/**
 * "platform.managed=true,platform.project_id=01ABC" → { "platform.managed": "true", ... }
 *
 * ค่าที่มี "=" อยู่ข้างในถูกเก็บครบ (แยกที่ "=" ตัวแรกเท่านั้น) ส่วน token ที่ไม่มี "=" เลยถูกข้าม
 *
 * ข้อจำกัดที่ยอมรับ: label ที่ *ค่า* มี comma จะถูกตัดผิด — Docker ไม่ escape ให้ในรูปแบบนี้
 * จึงแยกไม่ออกในทุกกรณี ownership labels ของเรา (ADR-0005) เป็น ULID/boolean ล้วนจึงไม่กระทบ
 */
export function parseLabelString(labelsStr: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of labelsStr.split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    out[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return out;
}
