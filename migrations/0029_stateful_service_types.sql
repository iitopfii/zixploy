-- migrate:disable-foreign-keys

-- migrate:up

-- เพิ่มชนิด managed service: pgvector, minio, clamav
--
-- services.type มี CHECK ล็อกชนิดไว้ (0015) — SQLite แก้ CHECK ตรง ๆ ไม่ได้ ต้อง rebuild ตาราง
-- ตารางนี้เป็น parent ของ service_jobs/service_backups/service_logs/terminal_sessions (ON DELETE CASCADE)
-- และ project_components.managed_service_id จึง**ต้อง**ปิด foreign_keys ระหว่าง rebuild (directive บรรทัดแรก)
-- ไม่งั้น DROP TABLE services = DELETE ทุกแถว → cascade ลบ backup/log/job ของทุก service ทิ้งหมด
-- runner ตรวจ PRAGMA foreign_key_check ก่อน commit ให้อีกชั้น
--
-- ใช้ลำดับ create new → copy → drop old → rename new ตาม sqlite.org/lang_altertable.html#otheralter
-- (ไม่ใช่ rename old ก่อน — rename ตาราง parent จะพา REFERENCES ของตารางลูกไปชี้ชื่อ _old ด้วย)

CREATE TABLE services_new (
  id TEXT PRIMARY KEY,

  -- ชื่อที่ผู้ใช้ตั้ง — unique ทั้งระบบเพื่อไม่ให้สับสนตอนเลือกใน dropdown ของ app
  name TEXT NOT NULL UNIQUE,

  -- ชนิดจาก SERVICE_CATALOG (@zixploy/shared/services.ts) — CHECK ที่นี่กันข้อมูลเพี้ยน
  -- ถ้าเพิ่มชนิดใหม่ในอนาคตต้องมี migration แก้ CHECK ด้วย (ตั้งใจให้ schema เป็น source of truth ชั้นสุดท้าย)
  type TEXT NOT NULL CHECK (type IN (
    'postgres', 'mysql', 'mariadb', 'redis', 'mongodb', 'libsql',
    'pgvector', 'minio', 'clamav'
  )),

  -- image tag ที่เลือก ต้องอยู่ใน template.versions (validate ที่ API ด้วย resolveVersion)
  version TEXT NOT NULL,
  -- image ref เต็มที่ใช้จริงตอน create — เก็บไว้เพื่อรู้ว่า container ที่รันอยู่มาจาก image ไหนแน่
  image TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating', 'starting', 'running', 'stopped', 'failed', 'deleting')),

  container_id TEXT,
  volume_name TEXT NOT NULL UNIQUE,

  -- ── Credentials ── (ดู 0015)
  username TEXT NOT NULL,
  database_name TEXT NOT NULL,
  password_enc BLOB,

  -- ── Networking ──
  internal_port INTEGER NOT NULL CHECK (internal_port BETWEEN 1 AND 65535),
  exposed_port INTEGER UNIQUE CHECK (exposed_port IS NULL OR exposed_port BETWEEN 1 AND 65535),

  -- ── Resources ──
  memory_limit_mb INTEGER CHECK (memory_limit_mb IS NULL OR memory_limit_mb > 0),
  cpu_limit REAL CHECK (cpu_limit IS NULL OR cpu_limit > 0),

  failure_message TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_started_at INTEGER,

  -- ── Backups ── (0021)
  backup_enabled INTEGER NOT NULL DEFAULT 0 CHECK (backup_enabled IN (0, 1)),
  backup_interval_hours INTEGER CHECK (backup_interval_hours IS NULL OR backup_interval_hours > 0),
  backup_retention_count INTEGER NOT NULL DEFAULT 7 CHECK (backup_retention_count BETWEEN 1 AND 30),
  last_backup_at INTEGER
);

INSERT INTO services_new
  (id, name, type, version, image, status, container_id, volume_name,
   username, database_name, password_enc, internal_port, exposed_port,
   memory_limit_mb, cpu_limit, failure_message, created_at, updated_at, last_started_at,
   backup_enabled, backup_interval_hours, backup_retention_count, last_backup_at)
SELECT id, name, type, version, image, status, container_id, volume_name,
       username, database_name, password_enc, internal_port, exposed_port,
       memory_limit_mb, cpu_limit, failure_message, created_at, updated_at, last_started_at,
       backup_enabled, backup_interval_hours, backup_retention_count, last_backup_at
FROM services;

DROP TABLE services;
ALTER TABLE services_new RENAME TO services;

CREATE INDEX idx_services_status ON services(status);
CREATE INDEX idx_services_type ON services(type);

-- migrate:down

-- service ชนิดใหม่ตกไประหว่าง rollback (ชนิดนั้นไม่มีใน schema เก่า) — foreign_keys ปิดอยู่
-- cascade จึงไม่ทำงาน ต้องเก็บแถวลูกเองไม่ให้เหลือ orphan (runner ตรวจ foreign_key_check)
DELETE FROM service_jobs WHERE service_id IN
  (SELECT id FROM services WHERE type IN ('pgvector', 'minio', 'clamav'));
DELETE FROM service_backups WHERE service_id IN
  (SELECT id FROM services WHERE type IN ('pgvector', 'minio', 'clamav'));
DELETE FROM service_logs WHERE service_id IN
  (SELECT id FROM services WHERE type IN ('pgvector', 'minio', 'clamav'));
DELETE FROM terminal_sessions WHERE service_id IN
  (SELECT id FROM services WHERE type IN ('pgvector', 'minio', 'clamav'));
UPDATE project_components SET managed_service_id = NULL WHERE managed_service_id IN
  (SELECT id FROM services WHERE type IN ('pgvector', 'minio', 'clamav'));

CREATE TABLE services_old (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('postgres', 'mysql', 'mariadb', 'redis', 'mongodb', 'libsql')),
  version TEXT NOT NULL,
  image TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating', 'starting', 'running', 'stopped', 'failed', 'deleting')),
  container_id TEXT,
  volume_name TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  database_name TEXT NOT NULL,
  password_enc BLOB,
  internal_port INTEGER NOT NULL CHECK (internal_port BETWEEN 1 AND 65535),
  exposed_port INTEGER UNIQUE CHECK (exposed_port IS NULL OR exposed_port BETWEEN 1 AND 65535),
  memory_limit_mb INTEGER CHECK (memory_limit_mb IS NULL OR memory_limit_mb > 0),
  cpu_limit REAL CHECK (cpu_limit IS NULL OR cpu_limit > 0),
  failure_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_started_at INTEGER,
  backup_enabled INTEGER NOT NULL DEFAULT 0 CHECK (backup_enabled IN (0, 1)),
  backup_interval_hours INTEGER CHECK (backup_interval_hours IS NULL OR backup_interval_hours > 0),
  backup_retention_count INTEGER NOT NULL DEFAULT 7 CHECK (backup_retention_count BETWEEN 1 AND 30),
  last_backup_at INTEGER
);

INSERT INTO services_old
  (id, name, type, version, image, status, container_id, volume_name,
   username, database_name, password_enc, internal_port, exposed_port,
   memory_limit_mb, cpu_limit, failure_message, created_at, updated_at, last_started_at,
   backup_enabled, backup_interval_hours, backup_retention_count, last_backup_at)
SELECT id, name, type, version, image, status, container_id, volume_name,
       username, database_name, password_enc, internal_port, exposed_port,
       memory_limit_mb, cpu_limit, failure_message, created_at, updated_at, last_started_at,
       backup_enabled, backup_interval_hours, backup_retention_count, last_backup_at
FROM services
WHERE type NOT IN ('pgvector', 'minio', 'clamav');

DROP TABLE services;
ALTER TABLE services_old RENAME TO services;

CREATE INDEX idx_services_status ON services(status);
CREATE INDEX idx_services_type ON services(type);
