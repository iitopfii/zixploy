import { AppError, toErrorEnvelope, ulid } from "@zixploy/shared";
import { Elysia } from "elysia";

/**
 * Map ทุก error เป็น error envelope เดียวกัน (docs/conventions.md)
 * ห้ามให้ stack trace / internal message หลุดออก response
 */
export const errorHandler = new Elysia({ name: "error-handler" }).onError(
  { as: "global" },
  ({ error, code, set }) => {
    // requestId ถูก set ไว้ใน header แล้วโดย request-id plugin; ดึงกลับมาใส่ envelope
    const headers = set.headers as Record<string, string | undefined>;
    const requestId = headers["X-Request-Id"] ?? ulid();

    if (error instanceof AppError) {
      set.status = error.status;
      return toErrorEnvelope(error, requestId);
    }

    if (code === "VALIDATION") {
      set.status = 400;
      return toErrorEnvelope(
        new AppError("VALIDATION_ERROR", "request ไม่ผ่าน validation", {
          summary: error instanceof Error ? error.message.split("\n")[0] : undefined,
        }),
        requestId,
      );
    }

    if (code === "NOT_FOUND") {
      set.status = 404;
      return toErrorEnvelope(new AppError("NOT_FOUND", "ไม่พบ endpoint นี้"), requestId);
    }

    // unknown error — log ฝั่ง server เท่านั้น ไม่ส่งรายละเอียดออกไป
    console.error(
      JSON.stringify({
        level: "error",
        requestId,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    set.status = 500;
    return toErrorEnvelope(new AppError("INTERNAL_ERROR", "เกิดข้อผิดพลาดภายในระบบ"), requestId);
  },
);
