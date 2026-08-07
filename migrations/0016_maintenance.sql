-- migrate:up

-- System maintenance jobs — Phase 11
--
-- งานระดับ "ทั้งเครื่อง" ที่ไม่ผูกกับ project หรือ service ตัวใดตัวหนึ่ง (ล้าง build cache,
-- ลบ dangling image) จึงใส่ใน deploy_jobs ไม่ได้ — ตารางนั้น project_id เป็น NOT NULL
-- และ unique index ผูกกับ project
--
-- ADR-0002 เหมือนเดิม: control-api สร้างงาน worker เป็นคนแตะ Docker

CREATE TABLE maintenance_jobs (
  id TEXT PRIMARY KEY,

  type TEXT NOT NULL CHECK (type IN ('prune_build_cache', 'prune_images', 'prune_all')),

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'done', 'failed')),

  lease_owner TEXT,
  lease_expires_at INTEGER,

  -- ผลลัพธ์ที่รายงานกลับให้ UI — จำนวน byte ที่คืนมาได้จริงจาก docker
  reclaimed_bytes INTEGER,
  -- สรุปเป็นข้อความ เช่น "build cache 1.2GB, images 340MB" สำหรับแสดงตรง ๆ
  summary TEXT,
  failure_message TEXT,

  requested_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);

-- หนึ่งงานค้างได้ครั้งละหนึ่ง (ทั้งระบบ) — prune ซ้อนกันทำให้ตัวเลข reclaimed เพี้ยน
-- และ docker prune พร้อมกันหลายตัวชิงกันลบ layer เดียวกัน
CREATE UNIQUE INDEX idx_maintenance_jobs_one_active ON maintenance_jobs(status)
  WHERE status IN ('pending', 'leased');

CREATE INDEX idx_maintenance_jobs_recent ON maintenance_jobs(created_at DESC);

-- migrate:down

DROP INDEX IF EXISTS idx_maintenance_jobs_recent;
DROP INDEX IF EXISTS idx_maintenance_jobs_one_active;
DROP TABLE IF EXISTS maintenance_jobs;
