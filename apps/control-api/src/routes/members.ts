/**
 * Member routes — จัดการสมาชิกและสิทธิ์ (0.1.28) · admin เท่านั้น (auth/policy.ts)
 *
 *   GET    /api/v1/members              — รายชื่อสมาชิก + โปรเจกต์ที่เข้าถึงได้
 *   POST   /api/v1/members              — เพิ่มสมาชิก (admin ตั้งรหัสผ่านเริ่มต้นให้)
 *   PATCH  /api/v1/members/:id          — เปลี่ยน role / ปิด-เปิดบัญชี / ตั้งรหัสผ่านใหม่ / โปรเจกต์
 *   DELETE /api/v1/members/:id          — ลบสมาชิก
 *
 * กติกาที่กันล็อกตัวเองออกจากระบบ: ต้องเหลือ admin ที่ใช้งานได้อย่างน้อย 1 คนเสมอ
 * และแก้ role/ปิด/ลบบัญชีของตัวเองไม่ได้
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, isUlid, type UserRole, ulid } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import { getClientIp, recordAuditEvent } from "../audit/log";
import { hashPassword, PASSWORD_MIN_LENGTH } from "../auth/password";
import { revokeAllSessions } from "../auth/session";
import { authPlugin, requireAuthenticated } from "../plugins/auth";

interface MemberRow {
  id: string;
  username: string;
  role: UserRole;
  disabled_at: number | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
}

const roleSchema = t.Union([t.Literal("admin"), t.Literal("developer"), t.Literal("viewer")]);

const memberSchema = t.Object({
  id: t.String(),
  username: t.String(),
  role: roleSchema,
  disabled: t.Boolean(),
  /** โปรเจกต์ที่เข้าถึงได้ — admin เห็นทุกโปรเจกต์อยู่แล้ว ค่านี้จึงไม่มีผลกับ admin */
  projectIds: t.Array(t.String()),
  lastSeenAt: t.Nullable(t.Number()),
  createdAt: t.Number(),
  updatedAt: t.Number(),
});

const usernameSchema = t.String({ minLength: 3, maxLength: 64, pattern: "^[a-zA-Z0-9._-]+$" });
const passwordSchema = t.String({ minLength: PASSWORD_MIN_LENGTH, maxLength: 256 });
const projectIdsSchema = t.Array(t.String(), { maxItems: 500 });

const createBody = t.Object({
  username: usernameSchema,
  password: passwordSchema,
  role: roleSchema,
  projectIds: t.Optional(projectIdsSchema),
});

const updateBody = t.Object({
  role: t.Optional(roleSchema),
  disabled: t.Optional(t.Boolean()),
  password: t.Optional(passwordSchema),
  projectIds: t.Optional(projectIdsSchema),
});

const SELECT_MEMBER = `
  SELECT u.id, u.username, u.role, u.disabled_at, u.created_at, u.updated_at,
         (SELECT max(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
  FROM users u`;

function projectIdsOf(db: Database, userId: string): string[] {
  return db
    .query<{ project_id: string }, [string]>(
      "SELECT project_id FROM project_members WHERE user_id = ? ORDER BY project_id",
    )
    .all(userId)
    .map((r) => r.project_id);
}

function toMember(db: Database, row: MemberRow) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    disabled: row.disabled_at !== null,
    projectIds: projectIdsOf(db, row.id),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function loadMember(db: Database, id: string): MemberRow {
  const row = isUlid(id)
    ? db.query<MemberRow, [string]>(`${SELECT_MEMBER} WHERE u.id = ?`).get(id)
    : null;
  if (!row) throw new AppError("NOT_FOUND", { th: "ไม่พบสมาชิกนี้", en: "Member not found" });
  return row;
}

/** จำนวน admin ที่ยังใช้งานได้ ไม่นับ `exceptUserId` */
function otherActiveAdmins(db: Database, exceptUserId: string): number {
  return (
    db
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id != ?",
      )
      .get(exceptUserId)?.n ?? 0
  );
}

function assertProjectsExist(db: Database, projectIds: string[]): string[] {
  const unique = [...new Set(projectIds)];
  for (const id of unique) {
    const exists = isUlid(id)
      ? db.query<{ n: number }, [string]>("SELECT 1 AS n FROM projects WHERE id = ?").get(id)
      : null;
    if (!exists) {
      throw new AppError(
        "VALIDATION_ERROR",
        { th: "มี project ที่ไม่มีอยู่ในรายการที่เลือก", en: "One of the selected projects does not exist" },
        {
          field: "projectIds",
          projectId: id,
        },
      );
    }
  }
  return unique;
}

function replaceProjects(db: Database, userId: string, projectIds: string[], now: number): void {
  db.query("DELETE FROM project_members WHERE user_id = ?").run(userId);
  const insert = db.query(
    "INSERT INTO project_members (project_id, user_id, created_at) VALUES (?, ?, ?)",
  );
  for (const projectId of projectIds) insert.run(projectId, userId, now);
}

export function memberRoutes(db: Database) {
  return new Elysia({ prefix: `${API_PREFIX}/members` })
    .use(authPlugin(db))
    .guard({ beforeHandle: requireAuthenticated })

    .get(
      "/",
      () => {
        const rows = db.query<MemberRow, []>(`${SELECT_MEMBER} ORDER BY u.id`).all();
        return { items: rows.map((row) => toMember(db, row)) };
      },
      { response: t.Object({ items: t.Array(memberSchema) }) },
    )

    .post(
      "/",
      async ({ body, set, request, requireUser }) => {
        const actor = requireUser();
        const duplicate = db
          .query<{ n: number }, [string]>("SELECT 1 AS n FROM users WHERE username = ?")
          .get(body.username);
        if (duplicate) {
          throw new AppError(
            "VALIDATION_ERROR",
            { th: "username นี้ถูกใช้แล้ว", en: "This username is already taken" },
            { field: "username" },
          );
        }
        const projectIds = assertProjectsExist(db, body.projectIds ?? []);
        const passwordHash = await hashPassword(body.password);

        const id = ulid();
        const now = Date.now();
        db.transaction(() => {
          db.query(
            `INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(id, body.username, passwordHash, body.role, now, now);
          replaceProjects(db, id, projectIds, now);
        })();

        recordAuditEvent(db, {
          actorUserId: actor.id,
          actorUsername: actor.username,
          action: "member_created",
          resourceType: "user",
          resourceId: id,
          metadata: { username: body.username, role: body.role, projectIds },
          ip: getClientIp(request),
        });

        set.status = 201;
        return toMember(db, loadMember(db, id));
      },
      { body: createBody, response: memberSchema },
    )

    .patch(
      "/:id",
      async ({ params, body, request, requireUser }) => {
        const actor = requireUser();
        const member = loadMember(db, params.id);
        const isSelf = member.id === actor.id;

        const roleChanges = body.role !== undefined && body.role !== member.role;
        const disables = body.disabled === true && member.disabled_at === null;
        const enables = body.disabled === false && member.disabled_at !== null;

        if (isSelf && (roleChanges || disables)) {
          throw new AppError("VALIDATION_ERROR", {
            th: "เปลี่ยน role หรือปิดบัญชีของตัวเองไม่ได้ — ให้ admin คนอื่นทำแทน",
            en: "You cannot change your own role or disable your own account. Ask another admin to do it",
          });
        }
        // ลด role ของ admin หรือปิดบัญชี admin: ต้องเหลือ admin ที่ใช้งานได้อีกอย่างน้อย 1 คน
        const losesAdmin =
          member.role === "admin" &&
          member.disabled_at === null &&
          ((roleChanges && body.role !== "admin") || disables);
        if (losesAdmin && otherActiveAdmins(db, member.id) === 0) {
          throw new AppError("VALIDATION_ERROR", {
            th: "ต้องมี admin ที่ใช้งานได้อย่างน้อย 1 คน",
            en: "At least one active admin is required",
          });
        }

        const projectIds =
          body.projectIds !== undefined ? assertProjectsExist(db, body.projectIds) : undefined;
        const passwordHash =
          body.password !== undefined ? await hashPassword(body.password) : undefined;

        const now = Date.now();
        const changed: string[] = [];
        db.transaction(() => {
          if (roleChanges && body.role) {
            db.query("UPDATE users SET role = ?, updated_at = ? WHERE id = ?").run(
              body.role,
              now,
              member.id,
            );
            changed.push("role");
          }
          if (disables || enables) {
            db.query("UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ?").run(
              disables ? now : null,
              now,
              member.id,
            );
            changed.push("disabled");
          }
          if (passwordHash !== undefined) {
            db.query("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
              passwordHash,
              now,
              member.id,
            );
            changed.push("password");
          }
          // ปิดบัญชีหรือตั้งรหัสผ่านใหม่ = session เดิมต้องใช้ไม่ได้อีก
          // (ตั้งรหัสผ่านของตัวเองผ่านทางนี้จะถูก logout ด้วย — ใช้หน้าบัญชีแทน)
          if (disables || passwordHash !== undefined) revokeAllSessions(db, member.id, now);
          if (projectIds !== undefined) {
            replaceProjects(db, member.id, projectIds, now);
            changed.push("projectIds");
          }
        })();

        if (changed.length > 0) {
          recordAuditEvent(db, {
            actorUserId: actor.id,
            actorUsername: actor.username,
            action: "member_updated",
            resourceType: "user",
            resourceId: member.id,
            // ไม่บันทึกรหัสผ่าน — เก็บแค่ว่าฟิลด์ไหนเปลี่ยน
            metadata: {
              username: member.username,
              fields: changed,
              ...(roleChanges ? { role: body.role } : {}),
              ...(disables || enables ? { disabled: disables } : {}),
            },
            ip: getClientIp(request),
          });
        }

        return toMember(db, loadMember(db, member.id));
      },
      { body: updateBody, response: memberSchema },
    )

    .delete(
      "/:id",
      ({ params, set, request, requireUser }) => {
        const actor = requireUser();
        const member = loadMember(db, params.id);
        if (member.id === actor.id) {
          throw new AppError("VALIDATION_ERROR", {
            th: "ลบบัญชีของตัวเองไม่ได้",
            en: "You cannot delete your own account",
          });
        }
        if (
          member.role === "admin" &&
          member.disabled_at === null &&
          otherActiveAdmins(db, member.id) === 0
        ) {
          throw new AppError("VALIDATION_ERROR", {
            th: "ต้องมี admin ที่ใช้งานได้อย่างน้อย 1 คน",
            en: "At least one active admin is required",
          });
        }

        db.transaction(() => {
          // audit log ต้องยังบอกได้ว่าใครทำ หลังบัญชีถูกลบ: เก็บ username ไว้แล้วปลด FK
          db.query(
            `UPDATE audit_events
             SET actor_username = COALESCE(actor_username, ?), actor_user_id = NULL
             WHERE actor_user_id = ?`,
          ).run(member.username, member.id);
          // sessions และ project_members ลบตาม ON DELETE CASCADE
          db.query("DELETE FROM users WHERE id = ?").run(member.id);
        })();

        recordAuditEvent(db, {
          actorUserId: actor.id,
          actorUsername: actor.username,
          action: "member_deleted",
          resourceType: "user",
          resourceId: member.id,
          metadata: { username: member.username, role: member.role },
          ip: getClientIp(request),
        });

        set.status = 204;
        return null;
      },
      { response: t.Null() },
    );
}
