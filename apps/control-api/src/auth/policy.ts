import type { Database } from "bun:sqlite";
import {
  API_PREFIX,
  AppError,
  type LocalizedText,
  roleAtLeast,
  type UserRole,
} from "@zixploy/shared";

/**
 * นโยบายสิทธิ์กลางของ Control API (0.1.28)
 *
 * ทุก route ที่ใช้ `requireAuthenticated` ผ่านที่นี่ — ตัดสินจาก method + path เท่านั้น
 * จึงตรวจทานได้ในไฟล์เดียว และ route ใหม่ที่ลืมประกาศสิทธิ์จะตกไปที่ค่าเริ่มต้น
 * "admin เท่านั้น" (fail-closed) ไม่ใช่เปิดให้ทุกคน
 *
 * กฎ:
 *   - /projects/:id/...       GET = สมาชิกของโปรเจกต์ (viewer ขึ้นไป) · อื่น ๆ = developer ที่เป็นสมาชิก
 *   - /deployments/:id/...    เหมือนกัน โดยหาโปรเจกต์จาก deployment
 *   - รายการที่ developer ต้องใช้ตอนตั้งค่าโปรเจกต์ (repo, branch, registry, managed service) อ่านได้
 *   - ที่เหลือทั้งหมด = admin
 *
 * โปรเจกต์/deployment ที่ผู้ใช้ไม่ใช่สมาชิกตอบ 404 เหมือนไม่มีอยู่ — ไม่เปิดเผยว่ามี id นั้น
 */

export interface CurrentUser {
  id: string;
  username: string;
  role: UserRole;
}

export type Access =
  | { kind: "authenticated" }
  | { kind: "role"; min: UserRole }
  | { kind: "project"; projectId: string; write: boolean }
  | { kind: "deployment"; deploymentId: string; write: boolean };

const ADMIN: Access = { kind: "role", min: "admin" };
const DEVELOPER: Access = { kind: "role", min: "developer" };
const AUTHENTICATED: Access = { kind: "authenticated" };

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** สิทธิ์ที่ request นี้ต้องมี — pure function ไม่แตะ DB */
export function requiredAccess(method: string, pathname: string): Access {
  if (!pathname.startsWith(`${API_PREFIX}/`)) return ADMIN;
  let segments: string[];
  try {
    // decode ก่อนเทียบ — กัน path ที่เข้ารหัสบางตัวอักษร (เช่น %6Dembers) หลบกฎของ segment นั้น
    segments = pathname
      .slice(API_PREFIX.length + 1)
      .split("/")
      .filter((s) => s.length > 0)
      .map((s) => decodeURIComponent(s));
  } catch {
    return ADMIN;
  }
  const [a, b, c] = segments;
  const write = !READ_METHODS.has(method.toUpperCase());

  switch (a) {
    case "auth":
      // login/logout/session/เปลี่ยนรหัสผ่านของตัวเอง
      return AUTHENTICATED;

    case "projects":
      // รายการโปรเจกต์: handler กรองตามสมาชิกเอง · สร้างโปรเจกต์ = admin
      if (!b) return write ? ADMIN : AUTHENTICATED;
      // สมาชิกของโปรเจกต์ และ archive = admin
      if (c === "members" || c === "archive") return ADMIN;
      return { kind: "project", projectId: b, write };

    case "deployments":
      if (!b) return ADMIN;
      return { kind: "deployment", deploymentId: b, write };

    case "github":
      // เลือก repo/branch ตอนตั้ง source ของโปรเจกต์
      if (!write && (b === "installations" || b === "branches")) return DEVELOPER;
      if (!write && b === "apps" && !c) return DEVELOPER;
      return ADMIN;

    case "registries":
      // เลือก registry ให้ component (รายการไม่มี credential)
      return !write && !b ? DEVELOPER : ADMIN;

    case "service-catalog":
      return write ? ADMIN : DEVELOPER;

    case "services":
      // รายการ/รายละเอียด managed service (ไม่มี credential) — endpoint ย่อยทั้งหมด = admin
      return !write && !c ? DEVELOPER : ADMIN;

    case "system":
      // เลขรุ่นที่แสดงใน layout
      return !write && b === "version" && !c ? AUTHENTICATED : ADMIN;

    default:
      return ADMIN;
  }
}

function isProjectMember(db: Database, projectId: string, userId: string): boolean {
  return (
    db
      .query<{ n: number }, [string, string]>(
        "SELECT 1 AS n FROM project_members WHERE project_id = ? AND user_id = ?",
      )
      .get(projectId, userId) !== null
  );
}

function assertProjectAccess(
  db: Database,
  user: CurrentUser,
  projectId: string,
  write: boolean,
  notFound: () => AppError,
): void {
  if (!isProjectMember(db, projectId, user.id)) throw notFound();
  if (write && !roleAtLeast(user.role, "developer")) {
    throw new AppError("FORBIDDEN", {
      th: "บัญชีนี้ดูได้อย่างเดียว ไม่มีสิทธิ์แก้ไขหรือ deploy",
      en: "This account is read-only and cannot edit or deploy",
    });
  }
}

/** โยน AppError เมื่อ user ไม่มีสิทธิ์ตาม `access` */
export function assertAccess(db: Database, user: CurrentUser, access: Access): void {
  if (user.role === "admin" || access.kind === "authenticated") return;

  switch (access.kind) {
    case "role":
      if (!roleAtLeast(user.role, access.min)) {
        throw new AppError(
          "FORBIDDEN",
          access.min === "admin"
            ? {
                th: "ต้องเป็น admin จึงจะใช้งานส่วนนี้ได้",
                en: "Only an admin can use this part of the system",
              }
            : {
                th: "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้",
                en: "This account is not allowed to use this part of the system",
              },
        );
      }
      return;

    case "project":
      assertProjectAccess(
        db,
        user,
        access.projectId,
        access.write,
        () => new AppError("PROJECT_NOT_FOUND", { th: "ไม่พบ project นี้", en: "Project not found" }),
      );
      return;

    case "deployment": {
      const notFound = () =>
        new AppError("DEPLOYMENT_NOT_FOUND", {
          th: "ไม่พบ deployment นี้",
          en: "Deployment not found",
        });
      const row = db
        .query<{ project_id: string }, [string]>("SELECT project_id FROM deployments WHERE id = ?")
        .get(access.deploymentId);
      if (!row) throw notFound();
      assertProjectAccess(db, user, row.project_id, access.write, notFound);
      return;
    }
  }
}

/** ใช้ใน handler ที่มีบางฟิลด์สงวนไว้ให้ admin (เช่น bind mount, link network) */
export function assertAdmin(user: CurrentUser, message: string | LocalizedText): void {
  if (user.role !== "admin") throw new AppError("FORBIDDEN", message);
}
