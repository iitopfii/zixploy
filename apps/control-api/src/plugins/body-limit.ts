import { AppError } from "@zixploy/shared";
import { Elysia } from "elysia";

/** ขนาด body สูงสุดของ Control API — payload ปกติเป็น JSON เล็ก ๆ (docs/phase-01) */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * ปฏิเสธ request ที่ประกาศ Content-Length เกินลิมิตก่อนอ่าน body
 * (Bun.serve บังคับลิมิตจริงอีกชั้นผ่าน maxRequestBodySize)
 */
export const bodyLimit = new Elysia({ name: "body-limit" }).onRequest(({ request }) => {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_BODY_BYTES) {
    throw new AppError("VALIDATION_ERROR", "request body ใหญ่เกินกำหนด");
  }
});
