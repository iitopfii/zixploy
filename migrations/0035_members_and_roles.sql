-- migrate:up

-- สมาชิกและสิทธิ์ (0.1.28) — เดิมระบบมี admin คนเดียวและไม่มี role
--   admin      ทำได้ทุกอย่าง รวมจัดการสมาชิกและตั้งค่าระบบ เห็นทุกโปรเจกต์
--   developer  deploy และแก้ไขได้ เฉพาะโปรเจกต์ที่ถูกเพิ่มใน project_members
--   viewer     ดูอย่างเดียว เฉพาะโปรเจกต์ที่ถูกเพิ่มใน project_members
-- user เดิมทุกคนเป็น admin (DEFAULT) — พฤติกรรมหลังอัปเกรดไม่เปลี่ยน
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'
  CHECK (role IN ('admin', 'developer', 'viewer'));

-- ปิดการใช้งานบัญชีโดยไม่ลบ — NULL = ใช้งานได้
ALTER TABLE users ADD COLUMN disabled_at INTEGER;

-- โปรเจกต์ที่ developer/viewer เข้าถึงได้ — admin ไม่ต้องมีแถวในตารางนี้
CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX idx_project_members_user ON project_members(user_id);

-- migrate:down

DROP INDEX IF EXISTS idx_project_members_user;
DROP TABLE IF EXISTS project_members;
ALTER TABLE users DROP COLUMN disabled_at;
ALTER TABLE users DROP COLUMN role;
