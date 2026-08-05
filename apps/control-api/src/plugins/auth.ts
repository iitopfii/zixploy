import type { Database } from "bun:sqlite";
import { AppError } from "@zixploy/shared";
import { Elysia } from "elysia";
import {
  type ActiveSession,
  CSRF_COOKIE,
  CSRF_HEADER,
  cookieValue,
  csrfTokensMatch,
  findActiveSession,
  SESSION_COOKIE,
  touchSession,
} from "../auth/session";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * แปลง session cookie เป็น session ที่ใช้งานได้ และให้ helper สำหรับบังคับ authentication
 *
 * `session` เป็น null เมื่อไม่มีคุกกี้/หมดอายุ/ถูก revoke — route ที่ต้องการ auth
 * เรียก `requireSession()` ซึ่งโยน AppError ให้ error handler แปลงเป็น envelope
 */
export function authPlugin(db: Database) {
  return new Elysia({ name: "auth" }).derive({ as: "global" }, ({ cookie, request }) => {
    const token = cookieValue(cookie[SESSION_COOKIE]);
    const session = token ? findActiveSession(db, token) : null;
    if (session) touchSession(db, session.sessionId);

    return {
      session,

      requireSession(): ActiveSession {
        if (!session) {
          throw new AppError("UNAUTHENTICATED", "ต้อง login ก่อนใช้งาน endpoint นี้");
        }
        return session;
      },

      /**
       * CSRF double-submit: คุกกี้ (อ่านได้จาก JS) ต้องตรงกับ header ที่ frontend ส่งมา
       * เว็บอื่นอ่านคุกกี้ของเราไม่ได้ จึงส่ง header ให้ตรงไม่ได้
       */
      assertCsrf(): void {
        if (!MUTATING_METHODS.has(request.method)) return;
        const fromCookie = cookieValue(cookie[CSRF_COOKIE]);
        const fromHeader = request.headers.get(CSRF_HEADER);
        if (!csrfTokensMatch(fromCookie, fromHeader)) {
          throw new AppError("CSRF_REJECTED", "CSRF token ไม่ถูกต้องหรือหายไป");
        }
      },
    };
  });
}

/** ใช้ใน route ที่ต้อง login + ผ่าน CSRF: `beforeHandle: [requireAuthenticated]` */
export function requireAuthenticated(ctx: {
  requireSession: () => ActiveSession;
  assertCsrf: () => void;
}): void {
  ctx.assertCsrf();
  ctx.requireSession();
}
