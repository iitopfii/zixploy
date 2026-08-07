/**
 * Log Routes — docs/phase-06-logs.md M3 + M4
 *
 * Build logs (worker writes → API reads from SQLite):
 *   GET /api/v1/deployments/:id/logs             — paginated historic (cursor: afterSeq)
 *   GET /api/v1/deployments/:id/logs/stream      — SSE live stream (Last-Event-ID = last seq)
 *   GET /api/v1/deployments/:id/logs/download    — plain text download (redacted already at write)
 *
 * Runtime logs (worker ring-buffer → API reads from SQLite):
 *   GET /api/v1/projects/:id/runtime-logs        — paginated (cursor: afterSeq)
 *   GET /api/v1/projects/:id/runtime-logs/stream — SSE live stream
 *
 * Security:
 *   - Secrets redacted ก่อน persist (worker side) — API ไม่ redact เพิ่มเติม
 *   - control-api ไม่แตะ Docker socket (architecture.test.ts guard) — runtime logs อ่านจาก DB
 *   - SSE: heartbeat ทุก LOG_SETTINGS.sseHeartbeatMs ผ่าน proxy timeout
 *   - SSE: หยุด stream เมื่อ deployment terminal + ไม่มี log ใหม่ 5 รอบ (graceful close)
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX, AppError, isTerminal, isUlid, LOG_SETTINGS } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import { listBuildLogs } from "../logs/build-store";
import { listRuntimeLogs, tailRuntimeLogs } from "../logs/runtime-store";
import { authPlugin, requireAuthenticated } from "../plugins/auth";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const logEntrySchema = t.Object({
  id: t.String(),
  deploymentId: t.String(),
  seq: t.Number(),
  stream: t.Union([t.Literal("stdout"), t.Literal("stderr")]),
  line: t.String(),
  createdAt: t.Number(),
});

const runtimeLogEntrySchema = t.Object({
  id: t.String(),
  projectId: t.String(),
  containerId: t.String(),
  seq: t.Number(),
  stream: t.Union([t.Literal("stdout"), t.Literal("stderr")]),
  line: t.String(),
  loggedAt: t.Number(),
  createdAt: t.Number(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireDeployment(db: Database, id: string): { id: string; status: string } {
  if (!isUlid(id)) throw new AppError("DEPLOYMENT_NOT_FOUND", "ไม่พบ deployment นี้");
  const row = db
    .query<{ id: string; status: string }, [string]>(
      "SELECT id, status FROM deployments WHERE id = ?",
    )
    .get(id);
  if (!row) throw new AppError("DEPLOYMENT_NOT_FOUND", "ไม่พบ deployment นี้");
  return row;
}

/**
 * จุดเริ่มของ SSE stream — Last-Event-ID มาก่อน แล้วค่อย ?afterSeq
 *
 * Last-Event-ID เป็นกลไกมาตรฐานตอนเบราว์เซอร์ reconnect เอง (ส่ง id ของ event สุดท้ายที่ได้รับ)
 * ส่วน ?afterSeq ใช้ตอนเปิด stream ครั้งแรก ซึ่ง client โหลด log ชุดแรกผ่าน REST ไปแล้ว
 * และรู้ว่าตัวเองมีถึง seq ไหน
 *
 * **เดิมอ่านแค่ header** ทำให้ตอนเชื่อมครั้งแรก afterSeq = 0 เสมอ → server ยิง log
 * ทั้ง ring buffer (2,000 บรรทัด ครั้งละ 500) กลับไปซ้ำกับที่ client มีอยู่แล้ว
 * เบราว์เซอร์ต้อง render ซ้ำทั้งหมดจนค้าง และ key ของ Vue ชนกันเพราะ seq ซ้ำ
 */
function resolveAfterSeq(
  lastEventId: string | undefined,
  queryAfterSeq: string | undefined,
): number {
  if (lastEventId && /^\d+$/.test(lastEventId)) return Number(lastEventId);
  if (queryAfterSeq && /^\d+$/.test(queryAfterSeq)) return Number(queryAfterSeq);
  return 0;
}

function requireProject(db: Database, id: string): void {
  if (!isUlid(id)) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
  const row = db
    .query<{ id: string }, [string]>("SELECT id FROM projects WHERE id = ? AND archived_at IS NULL")
    .get(id);
  if (!row) throw new AppError("PROJECT_NOT_FOUND", "ไม่พบ project นี้");
}

/**
 * สร้าง SSE ReadableStream ที่ poll SQLite ทุก ssePollMs
 * หยุดอัตโนมัติเมื่อ deployment เป็น terminal state + ไม่มี log ใหม่ N รอบติด
 */
function buildLogSseStream(db: Database, deploymentId: string, initialSeq: number): ReadableStream {
  const DRAIN_ROUNDS = 5; // รอ N รอบหลัง terminal ก่อนปิด — เผื่อ worker ยัง flush log สุดท้าย
  let lastSeq = initialSeq;
  let drainCount = 0;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  return new ReadableStream({
    start(controller) {
      function close() {
        if (closed) return;
        closed = true;
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        if (pollTimer) clearTimeout(pollTimer);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }

      function enqueue(data: string) {
        try {
          controller.enqueue(new TextEncoder().encode(data));
        } catch {
          close();
        }
      }

      function sendHeartbeat() {
        if (closed) return;
        enqueue(": heartbeat\n\n");
        heartbeatTimer = setTimeout(sendHeartbeat, LOG_SETTINGS.sseHeartbeatMs);
      }

      async function poll() {
        if (closed) return;
        try {
          const rows = listBuildLogs(db, deploymentId, {
            afterSeq: lastSeq,
            limit: LOG_SETTINGS.pageLimit,
          });

          for (const row of rows) {
            if (closed) return;
            const data = JSON.stringify({
              seq: row.seq,
              stream: row.stream,
              line: row.line,
              createdAt: row.createdAt,
            });
            enqueue(`id: ${row.seq}\ndata: ${data}\n\n`);
            lastSeq = row.seq;
          }

          // ตรวจสถานะ deployment เพื่อตัดสินใจว่าจะปิดหรือยัง
          const dep = db
            .query<{ status: string }, [string]>("SELECT status FROM deployments WHERE id = ?")
            .get(deploymentId);

          const terminal = dep ? isTerminal(dep.status as Parameters<typeof isTerminal>[0]) : true;

          if (terminal) {
            // หลัง terminal รอ drain อีก N รอบเผื่อ log ยังมาอยู่
            if (rows.length === 0) drainCount++;
            else drainCount = 0;
            if (drainCount >= DRAIN_ROUNDS) {
              close();
              return;
            }
          } else {
            drainCount = 0;
          }
        } catch {
          close();
          return;
        }
        if (!closed) {
          pollTimer = setTimeout(poll, LOG_SETTINGS.ssePollMs);
        }
      }

      // เริ่ม heartbeat + poll ทันที
      heartbeatTimer = setTimeout(sendHeartbeat, LOG_SETTINGS.sseHeartbeatMs);
      void poll();
    },
    cancel() {
      closed = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (pollTimer) clearTimeout(pollTimer);
    },
  });
}

/** SSE stream สำหรับ runtime logs (ring buffer polling) */
function runtimeLogSseStream(db: Database, projectId: string, initialSeq: number): ReadableStream {
  let lastSeq = initialSeq;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  return new ReadableStream({
    start(controller) {
      function close() {
        if (closed) return;
        closed = true;
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        if (pollTimer) clearTimeout(pollTimer);
        try {
          controller.close();
        } catch {
          // already closed
        }
      }

      function enqueue(data: string) {
        try {
          controller.enqueue(new TextEncoder().encode(data));
        } catch {
          close();
        }
      }

      function sendHeartbeat() {
        if (closed) return;
        enqueue(": heartbeat\n\n");
        heartbeatTimer = setTimeout(sendHeartbeat, LOG_SETTINGS.sseHeartbeatMs);
      }

      async function poll() {
        if (closed) return;
        try {
          const rows = listRuntimeLogs(db, projectId, { afterSeq: lastSeq });
          for (const row of rows) {
            if (closed) return;
            const data = JSON.stringify({
              seq: row.seq,
              containerId: row.containerId,
              stream: row.stream,
              line: row.line,
              loggedAt: row.loggedAt,
              createdAt: row.createdAt,
            });
            enqueue(`id: ${row.seq}\ndata: ${data}\n\n`);
            lastSeq = row.seq;
          }
        } catch {
          close();
          return;
        }
        if (!closed) {
          pollTimer = setTimeout(poll, LOG_SETTINGS.ssePollMs);
        }
      }

      heartbeatTimer = setTimeout(sendHeartbeat, LOG_SETTINGS.sseHeartbeatMs);
      void poll();
    },
    cancel() {
      closed = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (pollTimer) clearTimeout(pollTimer);
    },
  });
}

// ---------------------------------------------------------------------------
// Route module
// ---------------------------------------------------------------------------

export function logRoutes(db: Database) {
  return (
    new Elysia()
      .use(authPlugin(db))
      .guard({ beforeHandle: requireAuthenticated })

      // ── Build logs ─────────────────────────────────────────────────────────

      // GET /api/v1/deployments/:id/logs — paginated
      .get(
        `${API_PREFIX}/deployments/:id/logs`,
        ({ params, query }) => {
          requireDeployment(db, params.id);
          const logs = listBuildLogs(db, params.id, {
            ...(query.afterSeq !== undefined ? { afterSeq: query.afterSeq } : {}),
            ...(query.limit !== undefined ? { limit: query.limit } : {}),
          });
          return { logs };
        },
        {
          query: t.Object({
            afterSeq: t.Optional(t.Number({ minimum: 0 })),
            limit: t.Optional(t.Integer({ minimum: 1, maximum: 500 })),
          }),
          response: t.Object({ logs: t.Array(logEntrySchema) }),
        },
      )

      // GET /api/v1/deployments/:id/logs/stream — SSE
      .get(`${API_PREFIX}/deployments/:id/logs/stream`, ({ params, headers, query }) => {
        requireDeployment(db, params.id);

        const afterSeq = resolveAfterSeq(headers["last-event-id"], query.afterSeq);
        const stream = buildLogSseStream(db, params.id, afterSeq);
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no", // Nginx: ปิด buffer เพื่อให้ SSE ผ่านได้ทันที
          },
        });
      })

      // GET /api/v1/deployments/:id/logs/download — plain text
      .get(`${API_PREFIX}/deployments/:id/logs/download`, ({ params }) => {
        requireDeployment(db, params.id);
        const logs = listBuildLogs(db, params.id, { limit: LOG_SETTINGS.pageLimit });

        // format: [ISO timestamp] stdout/stderr  line text
        const text = logs
          .map((l) => {
            const ts = new Date(l.createdAt).toISOString();
            return `[${ts}] ${l.stream.padEnd(6)} ${l.line}`;
          })
          .join("\n");

        return new Response(text, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Disposition": `attachment; filename="build-${params.id}.log"`,
          },
        });
      })

      // ── Runtime logs ───────────────────────────────────────────────────────

      // GET /api/v1/projects/:id/runtime-logs — paginated
      .get(
        `${API_PREFIX}/projects/:id/runtime-logs`,
        ({ params, query }) => {
          requireProject(db, params.id);
          // ไม่ส่ง cursor = เปิดหน้าครั้งแรก → เอาบรรทัดล่าสุด ไม่ใช่เก่าสุดของ ring buffer
          const logs =
            query.afterSeq !== undefined
              ? listRuntimeLogs(db, params.id, { afterSeq: query.afterSeq })
              : tailRuntimeLogs(db, params.id);
          return { logs };
        },
        {
          query: t.Object({
            afterSeq: t.Optional(t.Number({ minimum: 0 })),
          }),
          response: t.Object({ logs: t.Array(runtimeLogEntrySchema) }),
        },
      )

      // GET /api/v1/projects/:id/runtime-logs/stream — SSE
      .get(`${API_PREFIX}/projects/:id/runtime-logs/stream`, ({ params, headers, query }) => {
        requireProject(db, params.id);

        const afterSeq = resolveAfterSeq(headers["last-event-id"], query.afterSeq);
        const stream = runtimeLogSseStream(db, params.id, afterSeq);
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      })
  );
}
