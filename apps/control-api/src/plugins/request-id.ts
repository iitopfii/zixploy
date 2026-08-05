import { REQUEST_ID_HEADER, ulid } from "@zixploy/shared";
import { Elysia } from "elysia";

const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * ทุก request ได้ requestId — ใช้ค่า client ถ้า format ถูกต้อง ไม่งั้น generate ใหม่
 * และตอบกลับใน X-Request-Id header เสมอ (docs/conventions.md)
 */
export const requestId = new Elysia({ name: "request-id" }).derive(
  { as: "global" },
  ({ request, set }) => {
    const fromClient = request.headers.get(REQUEST_ID_HEADER);
    const id = fromClient && CLIENT_ID_RE.test(fromClient) ? fromClient : ulid();
    set.headers[REQUEST_ID_HEADER] = id;
    return { requestId: id };
  },
);
