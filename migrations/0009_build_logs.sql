-- migrate:up

-- Build logs — ผูกกับ deployment ID
-- secrets ทุก line ถูก redact ก่อน insert โดย worker (ดู deploy-worker/src/logs/writer.ts)
-- ON DELETE CASCADE ให้ row หายไปพร้อม deployment เมื่อถูกลบตาม retention
CREATE TABLE build_logs (
  id             TEXT    PRIMARY KEY,
  deployment_id  TEXT    NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  stream         TEXT    NOT NULL DEFAULT 'stdout'
                   CHECK (stream IN ('stdout', 'stderr')),
  line           TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE (deployment_id, seq)
);

-- lookup: range query ตาม seq (SSE streaming + pagination) และ group by deployment
CREATE INDEX idx_build_logs_deployment_seq ON build_logs(deployment_id, seq);

-- Runtime logs — ring buffer per project
-- worker (deploy-worker) อ่านจาก `docker logs` แล้ว INSERT ที่นี่; control-api อ่านผ่าน SQLite
-- ไม่ให้ control-api แตะ Docker โดยตรง (ADR-0002 / architecture.test.ts)
-- ring buffer: worker รักษาจำนวนไม่เกิน RUNTIME_LOG_RING_SIZE ต่อ project เสมอ
CREATE TABLE runtime_logs (
  id            TEXT    PRIMARY KEY,
  project_id    TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  container_id  TEXT    NOT NULL,
  seq           INTEGER NOT NULL,
  stream        TEXT    NOT NULL DEFAULT 'stdout'
                  CHECK (stream IN ('stdout', 'stderr')),
  line          TEXT    NOT NULL,
  logged_at     INTEGER NOT NULL,  -- timestamp จาก docker logs --timestamps
  created_at    INTEGER NOT NULL,
  UNIQUE (project_id, seq)
);

CREATE INDEX idx_runtime_logs_project_seq ON runtime_logs(project_id, seq);

-- migrate:down
DROP INDEX IF EXISTS idx_runtime_logs_project_seq;
DROP TABLE IF EXISTS runtime_logs;
DROP INDEX IF EXISTS idx_build_logs_deployment_seq;
DROP TABLE IF EXISTS build_logs;
