import type { Database } from "bun:sqlite";
import { API_PREFIX, WORKER_HEARTBEAT } from "@zixploy/shared";
import { Elysia, t } from "elysia";

const checkSchema = t.Object({
  ready: t.Boolean(),
  detail: t.Optional(t.String()),
});

export const healthResponse = t.Object({
  status: t.Union([t.Literal("ok"), t.Literal("degraded")]),
  checks: t.Object({
    database: checkSchema,
    worker: checkSchema,
  }),
});

interface HeartbeatRow {
  worker_id: string;
  last_beat_at: number;
}

/** ตรวจ DB และ worker readiness แยกกัน (phase-00 การทดสอบ) */
export function systemRoutes(db: Database) {
  return new Elysia({ prefix: `${API_PREFIX}/system` }).get(
    "/health",
    () => {
      let database: { ready: boolean; detail?: string };
      let worker: { ready: boolean; detail?: string };

      try {
        db.query("SELECT 1").get();
        database = { ready: true };
      } catch {
        database = { ready: false, detail: "database query failed" };
      }

      try {
        const row = db
          .query<HeartbeatRow, []>(
            "SELECT worker_id, last_beat_at FROM worker_heartbeats ORDER BY last_beat_at DESC LIMIT 1",
          )
          .get();
        if (!row) {
          worker = { ready: false, detail: "no worker heartbeat recorded" };
        } else if (Date.now() - row.last_beat_at > WORKER_HEARTBEAT.staleMs) {
          worker = { ready: false, detail: "worker heartbeat is stale" };
        } else {
          worker = { ready: true };
        }
      } catch {
        worker = { ready: false, detail: "heartbeat table unavailable" };
      }

      return {
        status: database.ready && worker.ready ? ("ok" as const) : ("degraded" as const),
        checks: { database, worker },
      };
    },
    { response: healthResponse },
  );
}
