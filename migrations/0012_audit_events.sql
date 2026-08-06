-- Phase 8 M3: audit log — docs/phase-08-production.md "Web Security"
-- "Audit events สำหรับ login, config changes, deploy, rollback, volume deletion"
--
-- actor_username เก็บแยกจาก actor_user_id โดยตั้งใจ: login ที่ล้มเหลว (username ผิดหรือไม่มีจริง)
-- ไม่มี user_id ให้ผูก แต่ยังต้องการบันทึกไว้เพื่อ security review (brute force pattern ฯลฯ)

-- migrate:up

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id),
  actor_username TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  -- JSON object เสมอ — ไม่เก็บ secret/credential ใด ๆ (ผู้เรียก recordAuditEvent ต้องกรองเอง)
  metadata TEXT NOT NULL DEFAULT '{}',
  ip TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_audit_events_created ON audit_events(created_at DESC, id DESC);
CREATE INDEX idx_audit_events_resource ON audit_events(resource_type, resource_id);

-- migrate:down

DROP INDEX IF EXISTS idx_audit_events_resource;
DROP INDEX IF EXISTS idx_audit_events_created;
DROP TABLE IF EXISTS audit_events;
