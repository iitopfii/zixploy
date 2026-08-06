-- Phase 3: Deploy Engine — deployments + deploy_jobs (durable queue)
-- ดู docs/phase-03-deploy-engine.md, ADR-0002 (worker isolation), ADR-0003 (SQLite queue),
-- ADR-0004 (start-before-stop activation)

-- migrate:up

CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','cloning','building','starting','health_checking','activating','succeeded','failed','cancelled')),
  trigger TEXT NOT NULL CHECK (trigger IN ('push','manual','redeploy','rollback')),
  commit_sha TEXT NOT NULL,
  commit_message TEXT,
  commit_author TEXT,
  image_tag TEXT,
  image_digest TEXT,
  container_id TEXT,
  failure_code TEXT,
  failure_message TEXT,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  -- per-state timestamps สำหรับ timeline/debugging — nullable จนกว่าจะเข้า state นั้นจริง
  cloning_at INTEGER,
  building_at INTEGER,
  starting_at INTEGER,
  health_checking_at INTEGER,
  activating_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_deployments_project_created ON deployments(project_id, created_at DESC);

-- "current active deployment" lookup (restart/stop/rollback base)
CREATE INDEX idx_deployments_project_succeeded ON deployments(project_id, finished_at DESC)
  WHERE status = 'succeeded';

-- in-flight deployments (dashboard polling, health endpoint)
CREATE INDEX idx_deployments_in_flight ON deployments(project_id, created_at DESC)
  WHERE status NOT IN ('succeeded', 'failed', 'cancelled');

CREATE TABLE deploy_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  deployment_id TEXT REFERENCES deployments(id),
  type TEXT NOT NULL CHECK (type IN ('deploy', 'cleanup')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'done', 'failed', 'cancelled')),
  -- JSON discriminated union — payload.kind: build/rollback/restart/stop (deploy type)
  -- ดู apps/control-api/src/deploys/queue.ts สำหรับ shape เต็ม
  payload TEXT NOT NULL,
  -- manual > cleanup; ค่ามากกว่า claim ก่อน
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  -- ไม่ auto-retry build error — max_attempts ปกติ = 1 เว้นแต่กรณี infra transient
  max_attempts INTEGER NOT NULL DEFAULT 1,
  -- worker instance ID ที่ถือ lease อยู่ — ใช้คู่กับ lease_expires_at ตรวจว่า claim ยังสดอยู่ไหม
  lease_owner TEXT,
  lease_expires_at INTEGER,
  -- Control API ตั้งค่านี้แทนแตะ status/lease ของงานที่ leased อยู่ — กัน race กับ worker (ADR-0002)
  -- worker poll เองทุก iteration ของ pipeline loop
  cancel_requested_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- หนึ่ง pending job ต่อ project+type — enable coalescing (push ถี่ ๆ อัปเดต payload แทนสร้างแถวใหม่)
CREATE UNIQUE INDEX idx_deploy_jobs_one_pending_per_project_type
  ON deploy_jobs(project_id, type) WHERE status = 'pending';

-- หนึ่ง leased job ต่อ project+type — "หนึ่ง active deploy ต่อ project" (ADR-0003)
-- แยก index จาก pending โดยตั้งใจ: งาน pending ใหม่คิวต่อหลัง leased ได้โดยไม่ error (coalesce กับ pending)
CREATE UNIQUE INDEX idx_deploy_jobs_one_leased_per_project_type
  ON deploy_jobs(project_id, type) WHERE status = 'leased';

-- Worker claim order: priority DESC, oldest created_at ก่อน
CREATE INDEX idx_deploy_jobs_claimable ON deploy_jobs(status, priority DESC, created_at)
  WHERE status = 'pending';

-- Lease recovery sweep — หา leased job ที่ lease หมดอายุ (worker ตายแล้ว)
CREATE INDEX idx_deploy_jobs_lease_recovery ON deploy_jobs(status, lease_expires_at)
  WHERE status = 'leased';

-- migrate:down

DROP INDEX IF EXISTS idx_deploy_jobs_lease_recovery;
DROP INDEX IF EXISTS idx_deploy_jobs_claimable;
DROP INDEX IF EXISTS idx_deploy_jobs_one_leased_per_project_type;
DROP INDEX IF EXISTS idx_deploy_jobs_one_pending_per_project_type;
DROP TABLE IF EXISTS deploy_jobs;

DROP INDEX IF EXISTS idx_deployments_in_flight;
DROP INDEX IF EXISTS idx_deployments_project_succeeded;
DROP INDEX IF EXISTS idx_deployments_project_created;
DROP TABLE IF EXISTS deployments;
