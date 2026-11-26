import type { Database } from "bun:sqlite";
import { AppError, isUserRole } from "@zixploy/shared";
import { Elysia } from "elysia";
import { assertAccess, type CurrentUser, requiredAccess } from "../auth/policy";
import {
  type ActiveSession,
  CSRF_COOKIE,
  CSRF_HEADER,
  cookieValue,
  createSession,
  csrfTokensMatch,
  findActiveSession,
  hashToken,
  needsRotation,
  revokeSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  secureCookies,
  touchSession,
} from "../auth/session";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * แปลง session cookie เป็น session ที่ใช้งานได้ และให้ helper สำหรับบังคับ authentication
 *
 * `session` เป็น null เมื่อไม่มีคุกกี้/หมดอายุ/ถูก revoke — route ที่ต้องการ auth
 * เรียก `requireSession()` ซึ่งโยน AppError ให้ error handler แปลงเป็น envelope
 *
 * Session rotation (Phase 8 M5): session ที่เก่าเกิน SESSION_ROTATION_INTERVAL_MS จะถูกออก
 * token ใหม่แบบโปร่งใสในนี้เลย (ผู้ใช้ไม่รู้ตัว ไม่ต้อง login ใหม่) แล้ว revoke token เก่าทันที
 */
export function authPlugin(db: Database) {
  return new Elysia({ name: "auth" }).derive({ as: "global" }, ({ cookie, request }) => {
    const token = cookieValue(cookie[SESSION_COOKIE]);
    // capture CSRF cookie ก่อน rotation อาจ set ค่าใหม่ทับ — assertCsrf ต้องเทียบกับค่าที่ client
    // ส่งมาตอนต้น request นี้เท่านั้น ไม่ใช่ค่าที่เพิ่ง set ใน response ของ request เดียวกัน
    const csrfFromCookie = cookieValue(cookie[CSRF_COOKIE]);

    let session = token ? findActiveSession(db, token) : null;

    // โหลดผู้ใช้ทุก request — role ที่เปลี่ยนและบัญชีที่ถูกปิดมีผลทันที ไม่ต้องรอ session หมดอายุ
    let currentUser: CurrentUser | null = null;
    if (session) {
      const row = db
        .query<
          { id: string; username: string; role: string; disabled_at: number | null },
          [string]
        >("SELECT id, username, role, disabled_at FROM users WHERE id = ?")
        .get(session.userId);
      if (row && row.disabled_at === null && isUserRole(row.role)) {
        currentUser = { id: row.id, username: row.username, role: row.role };
      } else {
        session = null;
      }
    }

    if (session && token) {
      touchSession(db, session.sessionId);

      if (needsRotation(session)) {
        const rotated = createSession(db, session.userId);
        revokeSession(db, token);
        cookie[SESSION_COOKIE]?.set({
          value: rotated.token,
          httpOnly: true,
          secure: secureCookies,
          sameSite: "lax",
          path: "/",
          maxAge: SESSION_TTL_MS / 1000,
        });
        cookie[CSRF_COOKIE]?.set({
          value: rotated.csrfToken,
          httpOnly: false,
          secure: secureCookies,
          sameSite: "lax",
          path: "/",
          maxAge: SESSION_TTL_MS / 1000,
        });
        session = {
          sessionId: hashToken(rotated.token),
          userId: session.userId,
          createdAt: Date.now(),
          expiresAt: rotated.expiresAt,
        };
      }
    }

    return {
      session,
      currentUser,

      /** ผู้ใช้ของ request นี้ — โยน UNAUTHENTICATED ถ้าไม่ได้ login */
      requireUser(): CurrentUser {
        if (!currentUser) {
          throw new AppError("UNAUTHENTICATED", {
            th: "ต้อง login ก่อนใช้งาน endpoint นี้",
            en: "Sign in to use this endpoint",
          });
        }
        return currentUser;
      },

      /** ตรวจสิทธิ์ตามนโยบายกลาง (auth/policy.ts) จาก method + path ของ request นี้ */
      authorize(): void {
        if (!currentUser) {
          throw new AppError("UNAUTHENTICATED", {
            th: "ต้อง login ก่อนใช้งาน endpoint นี้",
            en: "Sign in to use this endpoint",
          });
        }
        const { pathname } = new URL(request.url);
        assertAccess(db, currentUser, requiredAccess(request.method, pathname));
      },

      requireSession(): ActiveSession {
        if (!session) {
          throw new AppError("UNAUTHENTICATED", {
            th: "ต้อง login ก่อนใช้งาน endpoint นี้",
            en: "Sign in to use this endpoint",
          });
        }
        return session;
      },

      /**
       * CSRF double-submit: คุกกี้ (อ่านได้จาก JS) ต้องตรงกับ header ที่ frontend ส่งมา
       * เว็บอื่นอ่านคุกกี้ของเราไม่ได้ จึงส่ง header ให้ตรงไม่ได้
       */
      assertCsrf(): void {
        if (!MUTATING_METHODS.has(request.method)) return;
        const fromHeader = request.headers.get(CSRF_HEADER);
        if (!csrfTokensMatch(csrfFromCookie, fromHeader)) {
          throw new AppError("CSRF_REJECTED", {
            th: "CSRF token ไม่ถูกต้องหรือหายไป",
            en: "The CSRF token is missing or invalid",
          });
        }
      },
    };
  });
}

/**
 * ใช้ใน route ที่ต้อง login + ผ่าน CSRF + มีสิทธิ์: `beforeHandle: [requireAuthenticated]`
 *
 * ตรวจ authentication ก่อน CSRF เสมอ เพื่อให้ status code สอดคล้องกันทุก method:
 * ไม่มี session = 401 ทั้ง GET และ mutation ส่วน 403 สงวนไว้สำหรับกรณีที่ login แล้ว
 * แต่ CSRF ไม่ผ่าน การสลับลำดับไม่ลดความปลอดภัย เพราะ request ที่ไม่มี session
 * ก็ทำอะไรไม่ได้อยู่แล้ว
 */
export function requireAuthenticated(ctx: {
  requireSession: () => ActiveSession;
  assertCsrf: () => void;
  authorize: () => void;
}): void {
  ctx.requireSession();
  ctx.assertCsrf();
  // สิทธิ์ตรวจหลัง CSRF: 403 ของ CSRF กับของ role ใช้ code ต่างกัน (CSRF_REJECTED / FORBIDDEN)
  ctx.authorize();
}
