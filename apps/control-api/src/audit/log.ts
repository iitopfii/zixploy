/**
 * Audit log — Phase 8 M3 (docs/phase-08-production.md "Web Security": "Audit events สำหรับ
 * login, config changes, deploy, rollback, volume deletion")
 *
 * recordAuditEvent() fail-open เสมอ: audit logging ต้องไม่ทำให้ action หลักของผู้ใช้ล้มเหลว
 * ห้ามส่ง secret/credential ใด ๆ เข้า metadata — เก็บแค่ field names/IDs ที่จำเป็นต่อการตรวจสอบ
 */

import type { Database } from "bun:sqlite";
import { ulid } from "@zixploy/shared";

export interface AuditEventInput {
  actorUserId?: string | null;
  actorUsername?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export function recordAuditEvent(db: Database, input: AuditEventInput): void {
  try {
    db.query(
      `INSERT INTO audit_events
         (id, actor_user_id, actor_username, action, resource_type, resource_id, metadata, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ulid(),
      input.actorUserId ?? null,
      input.actorUsername ?? null,
      input.action,
      input.resourceType ?? null,
      input.resourceId ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.ip ?? null,
      Date.now(),
    );
  } catch {
    // fail-open — ไม่ throw ทับ action หลักไม่ว่ากรณีใด (เช่น audit_events schema ยังไม่ migrate)
  }
}

/** อ่าน `x-forwarded-for` เท่านั้น (Traefik ตั้งให้เสมอ — docs/threat-model.md) — คืน null ถ้าไม่มี */
export function getClientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || null;
}

export interface AuditEventRow {
  id: string;
  actor_user_id: string | null;
  actor_username: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: string;
  ip: string | null;
  created_at: number;
}

const SELECT_COLUMNS = `id, actor_user_id, actor_username, action, resource_type, resource_id, metadata, ip, created_at`;

export interface ListAuditEventsParams {
  limit?: number;
  /** keyset pagination: แถวที่มี created_at < cursor.createdAt หรือเท่ากันแต่ id < cursor.id */
  before?: { createdAt: number; id: string };
}

export function listAuditEvents(db: Database, params: ListAuditEventsParams = {}): AuditEventRow[] {
  const limit = Math.min(200, Math.max(1, params.limit ?? 50));
  if (params.before) {
    return db
      .query<AuditEventRow, [number, number, string, number]>(
        `SELECT ${SELECT_COLUMNS} FROM audit_events
         WHERE created_at < ? OR (created_at = ? AND id < ?)
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(params.before.createdAt, params.before.createdAt, params.before.id, limit);
  }
  return db
    .query<AuditEventRow, [number]>(
      `SELECT ${SELECT_COLUMNS} FROM audit_events ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(limit);
}
