/**
 * Audit Events API (read-only) — Phase 8 M3
 *
 * GET /api/v1/audit-events — keyset pagination เดียวกับ /projects/:id/deployments
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import type { AuditEventRow } from "../audit/log";
import { listAuditEvents } from "../audit/log";
import { authPlugin, requireAuthenticated } from "../plugins/auth";

const auditEventSchema = t.Object({
  id: t.String(),
  actorUserId: t.Nullable(t.String()),
  actorUsername: t.Nullable(t.String()),
  action: t.String(),
  resourceType: t.Nullable(t.String()),
  resourceId: t.Nullable(t.String()),
  metadata: t.Record(t.String(), t.Unknown()),
  ip: t.Nullable(t.String()),
  createdAt: t.Number(),
});

function toAuditEvent(row: AuditEventRow) {
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorUsername: row.actor_username,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata,
    ip: row.ip,
    createdAt: row.created_at,
  };
}

function encodeCursor(row: { createdAt: number; id: string }): string {
  return Buffer.from(JSON.stringify(row)).toString("base64url");
}

function decodeCursor(value: string): { createdAt: number; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.createdAt === "number" &&
      typeof parsed.id === "string"
    ) {
      return parsed as { createdAt: number; id: string };
    }
    return null;
  } catch {
    return null;
  }
}

export function auditRoutes(db: Database) {
  return new Elysia({ prefix: API_PREFIX })
    .use(authPlugin(db))
    .guard({ beforeHandle: requireAuthenticated })
    .get(
      "/audit-events",
      ({ query }) => {
        const limit = Math.min(200, Math.max(1, Number(query.limit ?? 50)));
        const cursor = query.cursor ? decodeCursor(query.cursor) : null;

        const rows = listAuditEvents(db, {
          limit: limit + 1,
          ...(cursor ? { before: cursor } : {}),
        });

        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const last = page[page.length - 1];
        const nextCursor =
          hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : undefined;

        return { items: page.map(toAuditEvent), ...(nextCursor ? { nextCursor } : {}) };
      },
      {
        query: t.Object({
          limit: t.Optional(t.String()),
          cursor: t.Optional(t.String()),
        }),
        response: t.Object({
          items: t.Array(auditEventSchema),
          nextCursor: t.Optional(t.String()),
        }),
      },
    );
}
