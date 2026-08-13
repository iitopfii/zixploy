-- migrate:up

-- Runtime log ของ managed service (database) — โครงเดียวกับ runtime_logs ของ project
--
-- แยกตารางแทนที่จะเติม service_id ลง runtime_logs เพราะ runtime_logs มี
-- `project_id NOT NULL REFERENCES projects(id)` และ `UNIQUE (project_id, seq)` อยู่แล้ว
-- การทำให้ project_id nullable ต้อง rebuild ตารางที่เป็น hot path ของ log ทั้งระบบ
-- (worker เขียนทุก 2 วินาที) แลกกับการ dedup โค้ดไม่กี่สิบบรรทัด — ไม่คุ้มความเสี่ยง
--
-- ring buffer ต่อ service เท่ากับของ project (LOG_SETTINGS.runtimeRingSize) — worker ตัดให้เอง
CREATE TABLE service_logs (
  id            TEXT    PRIMARY KEY,
  service_id    TEXT    NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  container_id  TEXT    NOT NULL,
  seq           INTEGER NOT NULL,
  stream        TEXT    NOT NULL DEFAULT 'stdout'
                  CHECK (stream IN ('stdout', 'stderr')),
  line          TEXT    NOT NULL,
  logged_at     INTEGER NOT NULL,  -- timestamp จาก docker logs --timestamps
  created_at    INTEGER NOT NULL,
  UNIQUE (service_id, seq)
);

CREATE INDEX idx_service_logs_service_seq ON service_logs(service_id, seq);

-- migrate:down

DROP INDEX IF EXISTS idx_service_logs_service_seq;
DROP TABLE IF EXISTS service_logs;
