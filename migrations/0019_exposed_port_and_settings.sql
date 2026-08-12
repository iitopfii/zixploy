-- migrate:up

-- Phase 14 — (1) expose port ของ project ออก host โดยตรง (คู่ขนานกับ Traefik routing)
-- และ (2) system_settings สำหรับค่าที่แก้ได้จาก dashboard โดยไม่ต้องแตะ .env/restart

-- exposed_port: host port ที่ map เข้า internal_port ของ container (เช่น host 3100 → container 3000)
-- naming ตาม services.exposed_port (migration 0015) — ความหมายเดียวกันเป๊ะ
ALTER TABLE projects ADD COLUMN exposed_port INTEGER
  CHECK (exposed_port IS NULL OR exposed_port BETWEEN 1 AND 65535);

-- host port ซ้ำกันระหว่าง project ไม่ได้ (Docker bind ชนกัน) — partial index เพราะ NULL ซ้ำได้เสมอ
-- ข้าม project ↔ service ตรวจไม่ได้ด้วย constraint ข้ามตาราง — API เป็นคนเช็ค (routes/projects.ts)
CREATE UNIQUE INDEX idx_projects_exposed_port ON projects(exposed_port)
  WHERE exposed_port IS NOT NULL;

-- key-value เก็บการตั้งค่าระดับระบบ — ตอนนี้มีแค่ dashboard_domain (host ที่อนุญาตให้เข้า dashboard
-- เพิ่มเติมจาก ZIXPLOY_BASE_URL เพื่อแก้ INVALID_HOST ได้จาก UI โดยไม่ต้อง SSH ไปแก้ .env)
CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- migrate:down

DROP TABLE system_settings;
DROP INDEX IF EXISTS idx_projects_exposed_port;
ALTER TABLE projects DROP COLUMN exposed_port;
