/**
 * นำเข้า container ที่มีอยู่บนเครื่องแล้ว ให้เป็น project ที่จัดการได้ (migration 0028)
 *
 *   POST /api/v1/system/docker/containers/:containerId/import  — ขอให้ worker อ่าน config มาให้ตรวจ
 *   GET  /api/v1/system/docker/imports/:id                     — ดูผล/สถานะ
 *   POST /api/v1/system/docker/imports/:id/confirm             — ยืนยัน → worker สร้าง project
 *
 * ADR-0002: control-api ไม่แตะ Docker — แค่บันทึกคำขอลง DB แล้ว worker เป็นคนทำจริงทั้งหมด
 * ค่าของ env ไม่ผ่าน endpoint เหล่านี้เลย (preview คืนแค่ชื่อ key) — worker เข้ารหัสเก็บให้เอง
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, isUlid, ulid } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import { authPlugin, requireAuthenticated } from "../plugins/auth";

interface ImportRow {
  id: string;
  container_id: string;
  container_name: string;
  status: string;
  image: string | null;
  command: string | null;
  restart_policy: string | null;
  env_keys: string | null;
  ports: string | null;
  mounts: string | null;
  project_name: string | null;
  project_id: string | null;
  failure_message: string | null;
  created_at: number;
  updated_at: number;
}

const importSchema = t.Object({
  id: t.String(),
  containerId: t.String(),
  containerName: t.String(),
  status: t.Union([
    t.Literal("pending"),
    t.Literal("inspected"),
    t.Literal("confirmed"),
    t.Literal("done"),
    t.Literal("failed"),
  ]),
  image: t.Nullable(t.String()),
  command: t.Nullable(t.String()),
  restartPolicy: t.Nullable(t.String()),
  /** ชื่อ env ที่จะถูกนำเข้า — ไม่มีค่า (ค่าอยู่ใน container จนกว่า worker จะเข้ารหัสเก็บ) */
  envKeys: t.Array(t.String()),
  ports: t.Array(t.Object({ hostPort: t.Number(), containerPort: t.Number() })),
  mounts: t.Array(
    t.Object({
      source: t.String(),
      target: t.String(),
      type: t.String(),
      readOnly: t.Boolean(),
    }),
  ),
  projectName: t.Nullable(t.String()),
  projectId: t.Nullable(t.String()),
  failureMessage: t.Nullable(t.String()),
  createdAt: t.Number(),
  updatedAt: t.Number(),
});

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toDto(row: ImportRow) {
  return {
    id: row.id,
    containerId: row.container_id,
    containerName: row.container_name,
    status: row.status as "pending" | "inspected" | "confirmed" | "done" | "failed",
    image: row.image,
    command: row.command,
    restartPolicy: row.restart_policy,
    envKeys: parseJson<string[]>(row.env_keys, []),
    ports: parseJson<Array<{ hostPort: number; containerPort: number }>>(row.ports, []),
    mounts: parseJson<Array<{ source: string; target: string; type: string; readOnly: boolean }>>(
      row.mounts,
      [],
    ),
    projectName: row.project_name,
    projectId: row.project_id,
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_ALL = `id, container_id, container_name, status, image, command, restart_policy,
  env_keys, ports, mounts, project_name, project_id, failure_message, created_at, updated_at`;

function requireImport(db: Database, id: string): ImportRow {
  if (!isUlid(id)) throw new AppError("VALIDATION_ERROR", "ไม่พบคำขอนำเข้านี้");
  const row = db
    .query<ImportRow, [string]>(`SELECT ${SELECT_ALL} FROM container_imports WHERE id = ?`)
    .get(id);
  if (!row) throw new AppError("VALIDATION_ERROR", "ไม่พบคำขอนำเข้านี้");
  return row;
}

export function containerImportRoutes(db: Database) {
  return (
    new Elysia({ prefix: API_PREFIX })
      .use(authPlugin(db))
      .guard({ beforeHandle: requireAuthenticated })

      // ขอให้ worker อ่าน config ของ container มาให้ตรวจก่อนตัดสินใจ
      .post(
        "/system/docker/containers/:containerId/import",
        ({ params, set }) => {
          const containerId = params.containerId;
          // container ID ของ Docker เป็น hex เท่านั้น — กันค่าแปลกปลอมตั้งแต่ต้นทาง
          if (!/^[0-9a-f]{12,64}$/i.test(containerId)) {
            throw new AppError("VALIDATION_ERROR", "container id ไม่ถูกต้อง");
          }

          const known = db
            .query<{ name: string; is_managed: number }, [string]>(
              "SELECT name, is_managed FROM docker_containers WHERE container_id = ?",
            )
            .get(containerId);
          if (!known) {
            throw new AppError(
              "VALIDATION_ERROR",
              "ไม่พบ container นี้ในรายการล่าสุด — รอ worker กวาดข้อมูลรอบถัดไปแล้วลองใหม่",
            );
          }
          if (known.is_managed === 1) {
            throw new AppError(
              "VALIDATION_ERROR",
              "container นี้ถูกจัดการโดย Zixploy อยู่แล้ว ไม่ต้องนำเข้า",
            );
          }

          const id = ulid();
          const now = Date.now();
          db.query(
            `INSERT INTO container_imports
               (id, container_id, container_name, status, created_at, updated_at)
             VALUES (?, ?, ?, 'pending', ?, ?)`,
          ).run(id, containerId, known.name, now, now);

          set.status = 202;
          return toDto(requireImport(db, id));
        },
        { response: importSchema },
      )

      .get("/system/docker/imports/:id", ({ params }) => toDto(requireImport(db, params.id)), {
        response: importSchema,
      })

      // ยืนยันนำเข้า — worker จะสร้าง project ให้ (ยังไม่ deploy ผู้ใช้กดเองภายหลัง)
      .post(
        "/system/docker/imports/:id/confirm",
        ({ params, body, set }) => {
          const row = requireImport(db, params.id);
          if (row.status !== "inspected") {
            throw new AppError(
              "VALIDATION_ERROR",
              `ยืนยันได้เฉพาะคำขอที่อ่าน config เสร็จแล้ว (สถานะตอนนี้: ${row.status})`,
            );
          }
          const name = body.projectName?.trim();
          if (name && name.length > 100) {
            throw new AppError("VALIDATION_ERROR", "ชื่อ project ยาวเกิน 100 ตัวอักษร");
          }

          db.query(
            "UPDATE container_imports SET status = 'confirmed', project_name = ?, updated_at = ? WHERE id = ?",
          ).run(name ?? null, Date.now(), row.id);

          set.status = 202;
          return toDto(requireImport(db, row.id));
        },
        {
          body: t.Object({ projectName: t.Optional(t.String({ maxLength: 100 })) }),
          response: importSchema,
        },
      )
  );
}
