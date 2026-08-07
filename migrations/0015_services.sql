-- migrate:up

-- Managed services (one-click databases) — Phase 10
--
-- ตารางแยกจาก projects โดยตั้งใจ: service ไม่มี repository, ไม่ build, ไม่ผ่าน deploy queue
-- แค่ pull image จาก catalog แล้วรัน — ยัดลง projects จะทำให้ทุกหน้าต้อง if/else ว่าเป็นชนิดไหน
-- และ column ครึ่งหนึ่งของ projects (repo_id, branch, dockerfile_path, ...) ไม่มีความหมายเลย
--
-- container/volume name generate จาก id ด้วย serviceContainerName()/serviceVolumeName()
-- (@zixploy/shared/naming.ts) — immutable, ไม่ใช้ user input (ADR-0005)

CREATE TABLE services (
  id TEXT PRIMARY KEY,

  -- ชื่อที่ผู้ใช้ตั้ง — unique ทั้งระบบเพื่อไม่ให้สับสนตอนเลือกใน dropdown ของ app
  name TEXT NOT NULL UNIQUE,

  -- ชนิดจาก SERVICE_CATALOG (@zixploy/shared/services.ts) — CHECK ที่นี่กันข้อมูลเพี้ยน
  -- ถ้าเพิ่มชนิดใหม่ในอนาคตต้องมี migration แก้ CHECK ด้วย (ตั้งใจให้ schema เป็น source of truth ชั้นสุดท้าย)
  type TEXT NOT NULL CHECK (type IN ('postgres', 'mysql', 'mariadb', 'redis', 'mongodb', 'libsql')),

  -- image tag ที่เลือก ต้องอยู่ใน template.versions (validate ที่ API ด้วย resolveVersion)
  version TEXT NOT NULL,
  -- image ref เต็มที่ใช้จริงตอน create — เก็บไว้เพื่อรู้ว่า container ที่รันอยู่มาจาก image ไหนแน่
  image TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating', 'starting', 'running', 'stopped', 'failed', 'deleting')),

  container_id TEXT,
  volume_name TEXT NOT NULL UNIQUE,

  -- ── Credentials ──
  -- password เข้ารหัสด้วย envelope เดียวกับ env vars (AES-256-GCM + master key)
  -- AAD = "service:<id>:password" — ย้าย ciphertext ข้าม row แล้ว decrypt ไม่ได้
  -- username/database เก็บ plaintext ได้ (ไม่ใช่ความลับ และต้องใช้ประกอบ healthcheck/URI)
  username TEXT NOT NULL,
  database_name TEXT NOT NULL,
  password_enc BLOB,

  -- ── Networking ──
  internal_port INTEGER NOT NULL CHECK (internal_port BETWEEN 1 AND 65535),
  -- NULL = เข้าถึงได้เฉพาะ container อื่นใน network เดียวกัน (default ที่ปลอดภัย)
  -- มีค่า = publish ออก host ให้ต่อจากเครื่องตัวเองได้
  exposed_port INTEGER UNIQUE CHECK (exposed_port IS NULL OR exposed_port BETWEEN 1 AND 65535),

  -- ── Resources ──
  memory_limit_mb INTEGER CHECK (memory_limit_mb IS NULL OR memory_limit_mb > 0),
  cpu_limit REAL CHECK (cpu_limit IS NULL OR cpu_limit > 0),

  -- ข้อความอธิบายสาเหตุเมื่อ status = 'failed' — แสดงใน UI ให้แก้ได้ถูกจุด
  failure_message TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_started_at INTEGER
);

CREATE INDEX idx_services_status ON services(status);
CREATE INDEX idx_services_type ON services(type);

-- ── Job queue สำหรับ service lifecycle ──
-- แยกจาก deploy_jobs เพราะ payload/สถานะคนละชุด และไม่อยากให้ database provisioning
-- ไปแย่ง lease slot กับ deploy ของ app (unique index ของ deploy_jobs เป็น per-project)
--
-- worker claim งานจากตารางนี้เหมือน deploy_jobs ทุกประการ (lease + renewal) และ
-- **ไม่เคย INSERT เอง** — control-api เป็นผู้สร้างงานเสมอ (ADR-0002)
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

-- หนึ่งงาน pending และหนึ่งงาน leased ต่อ service (สอง index แยกกันเหมือน deploy_jobs)
-- ทำให้สั่ง restart ระหว่างที่ provision ยังไม่จบไม่ได้ — กัน operation ซ้อนกันบน container เดียว
CREATE UNIQUE INDEX idx_service_jobs_one_pending ON service_jobs(service_id)
  WHERE status = 'pending';
CREATE UNIQUE INDEX idx_service_jobs_one_leased ON service_jobs(service_id)
  WHERE status = 'leased';
CREATE INDEX idx_service_jobs_claimable ON service_jobs(status, created_at)
  WHERE status = 'pending';
CREATE INDEX idx_service_jobs_lease_recovery ON service_jobs(status, lease_expires_at)
  WHERE status = 'leased';

-- migrate:down

DROP INDEX IF EXISTS idx_service_jobs_lease_recovery;
DROP INDEX IF EXISTS idx_service_jobs_claimable;
DROP INDEX IF EXISTS idx_service_jobs_one_leased;
DROP INDEX IF EXISTS idx_service_jobs_one_pending;
DROP TABLE IF EXISTS service_jobs;
DROP INDEX IF EXISTS idx_services_type;
DROP INDEX IF EXISTS idx_services_status;
DROP TABLE IF EXISTS services;
