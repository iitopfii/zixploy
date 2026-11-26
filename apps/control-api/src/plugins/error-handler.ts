import { AppError, localeFromHeaders, toErrorEnvelope, ulid } from "@zixploy/shared";
import { Elysia } from "elysia";
import { log } from "../logger";

/**
 * Map ทุก error เป็น error envelope เดียวกัน (docs/conventions.md)
 * ห้ามให้ stack trace / internal message หลุดออก response
 */
export const errorHandler = new Elysia({ name: "error-handler" }).onError(
  { as: "global" },
  ({ error, code, set, request }) => {
    // ภาษาของข้อความ error ตามที่ client เลือก (header/คุกกี้) — ไม่ได้เลือก = ไทย
    const locale = localeFromHeaders(request.headers);

    // requestId ถูก set ไว้ใน header แล้วโดย request-id plugin; ดึงกลับมาใส่ envelope
    const headers = set.headers as Record<string, string | undefined>;
    const requestId = headers["X-Request-Id"] ?? ulid();

    if (error instanceof AppError) {
      set.status = error.status;
      return toErrorEnvelope(error, requestId, locale);
    }

    if (code === "VALIDATION") {
      set.status = 400;
      return toErrorEnvelope(
        new AppError(
          "VALIDATION_ERROR",
          { th: "request ไม่ผ่าน validation", en: "The request failed validation" },
          { summary: error instanceof Error ? error.message.split("\n")[0] : undefined },
        ),
        requestId,
        locale,
      );
    }

    if (code === "NOT_FOUND") {
      set.status = 404;
      return toErrorEnvelope(
        new AppError("NOT_FOUND", { th: "ไม่พบ endpoint นี้", en: "Endpoint not found" }),
        requestId,
        locale,
      );
    }

    // unknown error — log ฝั่ง server เท่านั้น (ผ่าน redaction) ไม่ส่งรายละเอียดออกไป
    log.error("unhandled error", {
      requestId,
      reason: error instanceof Error ? error.message : String(error),
    });
    set.status = 500;
    return toErrorEnvelope(
      new AppError("INTERNAL_ERROR", {
        th: "เกิดข้อผิดพลาดภายในระบบ",
        en: "An internal error occurred",
      }),
      requestId,
      locale,
    );
  },
);
