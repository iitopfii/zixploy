import { Elysia } from "elysia";
import { log } from "../logger";
import { requestId } from "./request-id";

/**
 * Access log แบบ structured — บันทึกเฉพาะ method, path, status และ requestId
 *
 * จงใจไม่บันทึก headers, cookies, query string หรือ body:
 * query อาจมีค่าที่ผู้ใช้ใส่มา และ header มี session/CSRF token (docs/threat-model.md)
 *
 * ใช้ requestId ตัวเดียวกับที่อยู่ใน response header และ error envelope เพื่อให้ตามรอยได้
 * (route ที่ไม่ match จะไม่มี requestId เพราะ derive ไม่ทำงาน — log จะไม่มี field นี้)
 */
export const requestLog = new Elysia({ name: "request-log" })
  .use(requestId)
  .onAfterResponse({ as: "global" }, (ctx) => {
    const { request, set, path } = ctx;
    const id = (ctx as { requestId?: string }).requestId;
    log.info("request", {
      requestId: id,
      method: request.method,
      // path เท่านั้น — ตัด query string ทิ้ง
      path,
      status: typeof set.status === "number" ? set.status : 200,
    });
  });
