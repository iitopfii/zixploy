-- migrate:up

-- Interactive terminal sessions into managed service containers (Phase 17)
--
-- ไม่เก็บเนื้อหา terminal ใด ๆ ในตารางนี้เลยโดยตั้งใจ — input/output ไหลผ่าน WebSocket
-- relay สด ๆ ระหว่าง browser <-> control-api <-> worker เท่านั้น (ดู
-- apps/control-api/src/routes/terminal.ts) ตารางนี้เป็นแค่ "กระดานงาน" ให้ worker
-- (ที่ poll เป็นระยะ ไม่มี server ของตัวเอง) รู้ว่ามี session ไหนรอให้ไปต่อ WebSocket ด้วย
--
-- ADR-0002: control-api สร้างแถว (status='pending') เท่านั้น — worker claim/update เอง
CREATE TABLE terminal_sessions (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'closed', 'failed')),
  failure_message TEXT,

  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  closed_at INTEGER
);

-- worker poll หาแถว pending บ่อย (ทุก ~1 วิ ต่างจาก loop อื่นที่ poll เป็นนาที) เพราะผู้ใช้
-- รอ terminal เปิดอยู่หน้าจอสด ๆ — ต้อง index ให้ query นี้เร็ว
CREATE INDEX idx_terminal_sessions_pending ON terminal_sessions(status, created_at)
  WHERE status = 'pending';

-- migrate:down

DROP INDEX IF EXISTS idx_terminal_sessions_pending;
DROP TABLE IF EXISTS terminal_sessions;
