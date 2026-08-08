import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import { getClientIp, recordAuditEvent } from "../audit/log";
import { hashPassword, PASSWORD_MIN_LENGTH, verifyPassword } from "../auth/password";
import { clearFailedLogins, isLoginRateLimited, recordFailedLogin } from "../auth/rate-limit";
import {
  CSRF_COOKIE,
  cookieValue,
  createSession,
  revokeAllSessions,
  revokeSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  secureCookies,
} from "../auth/session";
import { authPlugin, requireAuthenticated } from "../plugins/auth";

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
}

const loginBody = t.Object({
  username: t.String({ minLength: 1, maxLength: 64 }),
  password: t.String({ minLength: 1, maxLength: 256 }),
});

const sessionResponse = t.Object({
  authenticated: t.Boolean(),
  username: t.Optional(t.String()),
  expiresAt: t.Optional(t.Number()),
});

const changePasswordBody = t.Object({
  currentPassword: t.String({ minLength: 1, maxLength: 256 }),
  newPassword: t.String({ minLength: PASSWORD_MIN_LENGTH, maxLength: 256 }),
});

/** key สำหรับ rate limit — ใช้ IP ที่ Traefik ส่งมา ไม่ใช่ค่าที่ client ตั้งเองได้ทั้งหมด */
function clientKey(request: Request, server: { requestIP?: (r: Request) => unknown } | null) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return `ip:${forwarded.split(",")[0]?.trim()}`;
  const address = server?.requestIP?.(request) as { address?: string } | null | undefined;
  return `ip:${address?.address ?? "unknown"}`;
}

export function authRoutes(db: Database) {
  return (
    new Elysia({ prefix: `${API_PREFIX}/auth` })
      .use(authPlugin(db))
      .post(
        "/login",
        async ({ body, cookie, request, server, set }) => {
          const key = clientKey(request, server);

          if (isLoginRateLimited(db, key)) {
            throw new AppError("RATE_LIMITED", "พยายาม login ผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่");
          }

          const user = db
            .query<UserRow, [string]>(
              "SELECT id, username, password_hash FROM users WHERE username = ?",
            )
            .get(body.username);

          // ตอบข้อความเดียวกันทั้งกรณี user ไม่มีและ password ผิด เพื่อไม่ให้ enumerate username ได้
          const ok = user ? await verifyPassword(body.password, user.password_hash) : false;
          if (!user || !ok) {
            recordFailedLogin(db, body.username, key);
            recordAuditEvent(db, {
              actorUsername: body.username,
              action: "login_failed",
              resourceType: "session",
              ip: getClientIp(request),
            });
            throw new AppError("INVALID_CREDENTIALS", "username หรือ password ไม่ถูกต้อง");
          }

          clearFailedLogins(db, key);
          const session = createSession(db, user.id);
          recordAuditEvent(db, {
            actorUserId: user.id,
            actorUsername: user.username,
            action: "login_succeeded",
            resourceType: "session",
            ip: getClientIp(request),
          });

          cookie[SESSION_COOKIE]?.set({
            value: session.token,
            httpOnly: true,
            secure: secureCookies,
            sameSite: "lax",
            path: "/",
            maxAge: SESSION_TTL_MS / 1000,
          });
          // CSRF cookie ต้องอ่านได้จาก JS เพื่อส่งกลับมาใน header (double-submit)
          cookie[CSRF_COOKIE]?.set({
            value: session.csrfToken,
            httpOnly: false,
            secure: secureCookies,
            sameSite: "lax",
            path: "/",
            maxAge: SESSION_TTL_MS / 1000,
          });

          set.status = 200;
          return { authenticated: true, username: user.username, expiresAt: session.expiresAt };
        },
        { body: loginBody, response: sessionResponse },
      )
      .post(
        "/logout",
        ({ cookie, assertCsrf, request, session }) => {
          assertCsrf();
          const token = cookieValue(cookie[SESSION_COOKIE]);
          if (token) revokeSession(db, token);
          if (session) {
            recordAuditEvent(db, {
              actorUserId: session.userId,
              action: "logout",
              resourceType: "session",
              resourceId: session.sessionId,
              ip: getClientIp(request),
            });
          }
          cookie[SESSION_COOKIE]?.remove();
          cookie[CSRF_COOKIE]?.remove();
          return { authenticated: false };
        },
        { response: sessionResponse },
      )
      /**
       * เปลี่ยนรหัสผ่านของบัญชีตัวเอง
       *
       * ต้องยืนยันรหัสผ่านเดิมเสมอ แม้จะ login อยู่แล้ว — session ที่ถูกขโมย (เครื่องที่ลืม
       * logout, cookie ที่หลุด) จะได้เปลี่ยนรหัสผ่านยึดบัญชีไปเลยไม่ได้
       *
       * ใช้ rate limit ชุดเดียวกับ login เพราะเป็นการเดารหัสผ่านเหมือนกัน ต่างแค่ทางเข้า
       * — ถ้าไม่จำกัด ช่องนี้จะกลายเป็นทางอ้อมสำหรับ brute force ที่ไม่มีใครนับ
       *
       * สำเร็จแล้ว revoke ทุก session รวมถึงของตัวเอง: ผู้ใช้ที่เปลี่ยนรหัสผ่านมักทำเพราะ
       * สงสัยว่าถูกขโมย การเหลือ session อื่นไว้ทำให้ผู้บุกรุกยังอยู่ในระบบต่อ
       * แล้วออก session ใหม่ให้เครื่องที่เพิ่งเปลี่ยน จึงไม่ถูกเตะออกเอง
       */
      .post(
        "/change-password",
        async ({ body, cookie, assertCsrf, request, server, set, requireSession }) => {
          assertCsrf();
          const session = requireSession();
          const key = clientKey(request, server);

          if (isLoginRateLimited(db, key)) {
            throw new AppError("RATE_LIMITED", "ลองผิดหลายครั้งเกินไป — รอสักครู่แล้วลองใหม่");
          }

          const user = db
            .query<UserRow, [string]>("SELECT id, username, password_hash FROM users WHERE id = ?")
            .get(session.userId);
          if (!user) throw new AppError("UNAUTHENTICATED", "ไม่พบบัญชีผู้ใช้");

          if (!(await verifyPassword(body.currentPassword, user.password_hash))) {
            // ลำดับพารามิเตอร์คือ (db, username, clientKey) — สลับแล้ว rate limit จะไม่ทำงานเลย
            // เพราะบันทึก client_key เป็น username แล้วไปค้นด้วย key ที่ไม่มีวันตรง
            recordFailedLogin(db, user.username, key);
            recordAuditEvent(db, {
              actorUserId: user.id,
              action: "password_change_failed",
              resourceType: "user",
              resourceId: user.id,
              ip: getClientIp(request),
            });
            throw new AppError("INVALID_CREDENTIALS", "รหัสผ่านเดิมไม่ถูกต้อง");
          }

          if (body.newPassword === body.currentPassword) {
            throw new AppError("VALIDATION_ERROR", "รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม", {
              field: "newPassword",
            });
          }

          const now = Date.now();
          db.query("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
            await hashPassword(body.newPassword),
            now,
            user.id,
          );

          clearFailedLogins(db, key);
          revokeAllSessions(db, user.id, now);

          // ออก session ใหม่ให้เครื่องนี้ทันที — ไม่งั้นผู้ใช้ถูกเตะออกทั้งที่เพิ่งทำถูกต้อง
          const fresh = createSession(db, user.id, now);
          cookie[SESSION_COOKIE]?.set({
            value: fresh.token,
            httpOnly: true,
            sameSite: "lax",
            secure: secureCookies,
            path: "/",
            maxAge: SESSION_TTL_MS / 1000,
          });
          cookie[CSRF_COOKIE]?.set({
            value: fresh.csrfToken,
            httpOnly: false,
            sameSite: "lax",
            secure: secureCookies,
            path: "/",
            maxAge: SESSION_TTL_MS / 1000,
          });

          recordAuditEvent(db, {
            actorUserId: user.id,
            action: "password_changed",
            resourceType: "user",
            resourceId: user.id,
            ip: getClientIp(request),
          });

          set.status = 200;
          return { authenticated: true, username: user.username, expiresAt: fresh.expiresAt };
        },
        {
          beforeHandle: requireAuthenticated,
          body: changePasswordBody,
          response: sessionResponse,
        },
      )
      .get(
        "/session",
        ({ session }) => {
          if (!session) return { authenticated: false };
          const user = db
            .query<{ username: string }, [string]>("SELECT username FROM users WHERE id = ?")
            .get(session.userId);
          // ไม่ใส่ key เลยเมื่อไม่มีค่า (exactOptionalPropertyTypes) แทนการส่ง undefined
          return user
            ? { authenticated: true, username: user.username, expiresAt: session.expiresAt }
            : { authenticated: true, expiresAt: session.expiresAt };
        },
        { response: sessionResponse },
      )
  );
}
