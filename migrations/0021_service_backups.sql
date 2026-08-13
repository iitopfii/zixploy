-- migrate:up

-- Managed service backups (Phase 16) — dump/restore ของ database ที่ deploy ผ่าน one-click services
--
-- เก็บไฟล์บน Docker volume เดิมที่ control-api ใช้ backup ตัวเองอยู่แล้ว (zixploy-backups)
-- ใต้ subdirectory "services/<serviceId>/" — deploy-worker mount volume เดียวกันเพิ่ม
-- (ดู deploy/server/docker-compose.yml, deploy/install/docker-compose.yml)
CREATE TABLE service_backups (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,

  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),

  -- ชื่อไฟล์ (relative ใต้ services/<serviceId>/) — NULL จนกว่า backup จะเสร็จสำเร็จ
  file_name TEXT,
  size_bytes INTEGER,
  failure_message TEXT,

  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_service_backups_service_created ON service_backups(service_id, created_at DESC);

-- ── ตั้งค่า backup ต่อ service ──
-- ตัว interval ใช้ตัวเลขชั่วโมงจากตัวเลือกจำกัด (SERVICE_BACKUP_SETTINGS.allowedIntervalHours ใน
-- internal/shared) ไม่รับ cron expression ดิบ — กันตั้งค่าผิดพลาดและไม่ต้องพึ่ง cron parser
ALTER TABLE services ADD COLUMN backup_enabled INTEGER NOT NULL DEFAULT 0 CHECK (backup_enabled IN (0, 1));
ALTER TABLE services ADD COLUMN backup_interval_hours INTEGER CHECK (backup_interval_hours IS NULL OR backup_interval_hours > 0);
ALTER TABLE services ADD COLUMN backup_retention_count INTEGER NOT NULL DEFAULT 7 CHECK (backup_retention_count BETWEEN 1 AND 30);
ALTER TABLE services ADD COLUMN last_backup_at INTEGER;

-- ── service_jobs.type ต้องรองรับ 'backup'/'restore' เพิ่ม ──
-- SQLite แก้ CHECK constraint ตรง ๆ ไม่ได้ ต้องสร้างตารางใหม่แล้วย้ายข้อมูล (รูปแบบเดียวกับ 0017)
ALTER TABLE service_jobs RENAME TO service_jobs_old;

DROP INDEX IF EXISTS idx_service_jobs_one_pending;
DROP INDEX IF EXISTS idx_service_jobs_one_leased;
DROP INDEX IF EXISTS idx_service_jobs_claimable;
DROP INDEX IF EXISTS idx_service_jobs_lease_recovery;

CREATE TABLE service_jobs (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,

  type TEXT NOT NULL
    CHECK (type IN ('provision', 'start', 'stop', 'restart', 'destroy', 'backup', 'restore')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'done', 'failed', 'cancelled')),

  payload TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,

  lease_owner TEXT,
  lease_expires_at INTEGER,
  failure_message TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO service_jobs
  (id, service_id, type, status, payload, attempts, max_attempts,
   lease_owner, lease_expires_at, failure_message, created_at, updated_at)
SELECT id, service_id, type, status, payload, attempts, max_attempts,
       lease_owner, lease_expires_at, failure_message, created_at, updated_at
FROM service_jobs_old;

DROP TABLE service_jobs_old;

CREATE UNIQUE INDEX idx_service_jobs_one_pending ON service_jobs(service_id)
  WHERE status = 'pending';
CREATE UNIQUE INDEX idx_service_jobs_one_leased ON service_jobs(service_id)
  WHERE status = 'leased';
CREATE INDEX idx_service_jobs_claimable ON service_jobs(status, created_at)
  WHERE status = 'pending';
CREATE INDEX idx_service_jobs_lease_recovery ON service_jobs(status, lease_expires_at)
  WHERE status = 'leased';

-- migrate:down

ALTER TABLE service_jobs RENAME TO service_jobs_new;

DROP INDEX IF EXISTS idx_service_jobs_one_pending;
DROP INDEX IF EXISTS idx_service_jobs_one_leased;
DROP INDEX IF EXISTS idx_service_jobs_claimable;
DROP INDEX IF EXISTS idx_service_jobs_lease_recovery;

CREATE TABLE service_jobs (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('provision', 'start', 'stop', 'restart', 'destroy')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'done', 'failed', 'cancelled')),
  payload TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  failure_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- งาน backup/restore ตกไประหว่าง rollback — type นั้นไม่มีใน schema เก่า
INSERT INTO service_jobs
  (id, service_id, type, status, payload, attempts, max_attempts,
   lease_owner, lease_expires_at, failure_message, created_at, updated_at)
SELECT id, service_id, type, status, payload, attempts, max_attempts,
       lease_owner, lease_expires_at, failure_message, created_at, updated_at
FROM service_jobs_new
WHERE type NOT IN ('backup', 'restore');

DROP TABLE service_jobs_new;

CREATE UNIQUE INDEX idx_service_jobs_one_pending ON service_jobs(service_id)
  WHERE status = 'pending';
CREATE UNIQUE INDEX idx_service_jobs_one_leased ON service_jobs(service_id)
  WHERE status = 'leased';
CREATE INDEX idx_service_jobs_claimable ON service_jobs(status, created_at)
  WHERE status = 'pending';
CREATE INDEX idx_service_jobs_lease_recovery ON service_jobs(status, lease_expires_at)
  WHERE status = 'leased';

DROP TABLE IF EXISTS service_backups;

ALTER TABLE services DROP COLUMN last_backup_at;
ALTER TABLE services DROP COLUMN backup_retention_count;
ALTER TABLE services DROP COLUMN backup_interval_hours;
ALTER TABLE services DROP COLUMN backup_enabled;
