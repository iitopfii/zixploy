-- migrate:up

-- รองรับงาน self-update ใน maintenance_jobs — Phase 12
--
-- ใช้ตารางเดิมแทนสร้างใหม่ เพราะกลไกคิวที่ต้องการเหมือนกันเป๊ะ: หนึ่งงานค้างต่อระบบ
-- (update ซ้อนกันสองงานจะ pull/recreate ชนกันจนสถานะพัง), worker claim ด้วย lease,
-- รายงานผลกลับให้ UI — เขียนใหม่ทั้งชุดเพื่อ type เดียวไม่คุ้ม
--
-- SQLite แก้ CHECK constraint ตรง ๆ ไม่ได้ ต้องสร้างตารางใหม่แล้วย้ายข้อมูล
-- (รูปแบบเดียวกับ 0013 ที่เพิ่ม column ให้ project_domains)

ALTER TABLE maintenance_jobs RENAME TO maintenance_jobs_old;

DROP INDEX IF EXISTS idx_maintenance_jobs_one_active;
DROP INDEX IF EXISTS idx_maintenance_jobs_recent;

CREATE TABLE maintenance_jobs (
  id TEXT PRIMARY KEY,

  type TEXT NOT NULL
    CHECK (type IN ('prune_build_cache', 'prune_images', 'prune_all', 'self_update')),

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'done', 'failed')),

  lease_owner TEXT,
  lease_expires_at INTEGER,

  reclaimed_bytes INTEGER,
  summary TEXT,
  failure_message TEXT,

  -- เฉพาะ self_update: เวอร์ชันที่จะอัปไป (tag ของ image)
  -- เก็บไว้เพื่อให้รู้ว่างานนี้ตั้งใจไปเวอร์ชันไหน แม้ระหว่างทางจะมี release ใหม่ออกอีก
  target_version TEXT,
  from_version TEXT,

  requested_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);

INSERT INTO maintenance_jobs
  (id, type, status, lease_owner, lease_expires_at, reclaimed_bytes, summary,
   failure_message, requested_by, created_at, updated_at, finished_at)
SELECT id, type, status, lease_owner, lease_expires_at, reclaimed_bytes, summary,
       failure_message, requested_by, created_at, updated_at, finished_at
FROM maintenance_jobs_old;

DROP TABLE maintenance_jobs_old;

CREATE UNIQUE INDEX idx_maintenance_jobs_one_active ON maintenance_jobs(status)
  WHERE status IN ('pending', 'leased');
CREATE INDEX idx_maintenance_jobs_recent ON maintenance_jobs(created_at DESC);

-- migrate:down

ALTER TABLE maintenance_jobs RENAME TO maintenance_jobs_new;

DROP INDEX IF EXISTS idx_maintenance_jobs_one_active;
DROP INDEX IF EXISTS idx_maintenance_jobs_recent;

CREATE TABLE maintenance_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('prune_build_cache', 'prune_images', 'prune_all')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'done', 'failed')),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  reclaimed_bytes INTEGER,
  summary TEXT,
  failure_message TEXT,
  requested_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);

-- งาน self_update ตกไประหว่าง rollback — type นั้นไม่มีใน schema เก่า
INSERT INTO maintenance_jobs
  (id, type, status, lease_owner, lease_expires_at, reclaimed_bytes, summary,
   failure_message, requested_by, created_at, updated_at, finished_at)
SELECT id, type, status, lease_owner, lease_expires_at, reclaimed_bytes, summary,
       failure_message, requested_by, created_at, updated_at, finished_at
FROM maintenance_jobs_new
WHERE type <> 'self_update';

DROP TABLE maintenance_jobs_new;

CREATE UNIQUE INDEX idx_maintenance_jobs_one_active ON maintenance_jobs(status)
  WHERE status IN ('pending', 'leased');
CREATE INDEX idx_maintenance_jobs_recent ON maintenance_jobs(created_at DESC);
