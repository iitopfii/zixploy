-- Worker readiness ผ่าน DB heartbeat (ADR-0002) —
-- API health endpoint อ่านตารางนี้เพื่อรายงาน worker readiness แยกจาก DB readiness

-- migrate:up
CREATE TABLE worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  last_beat_at INTEGER NOT NULL
);

-- migrate:down
DROP TABLE worker_heartbeats;
