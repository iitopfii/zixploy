-- migrate:up

-- Named Docker volumes — docs/phase-07-volumes.md
-- docker_name สร้างโดย volumeName(projectId, volumeId) ใน @zixploy/shared/naming.ts (immutable, ไม่ใช้ user input)
-- lifecycle states: active (attached) → detached → deletion_pending → deleted | error
-- project archive/delete ไม่ลบ volumes โดยอัตโนมัติ (FK ไม่มี CASCADE ตาม phase-07)

CREATE TABLE volumes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  display_name TEXT NOT NULL,
  docker_name TEXT NOT NULL UNIQUE,
  mount_path TEXT NOT NULL,
  access_mode TEXT NOT NULL DEFAULT 'shared-safe'
    CHECK (access_mode IN ('shared-safe', 'single-writer')),
  driver TEXT NOT NULL DEFAULT 'local',
  driver_opts TEXT NOT NULL DEFAULT '{}',
  read_only INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1)),
  lifecycle TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle IN ('active', 'detached', 'deletion_pending', 'deleted', 'error')),
  last_attached_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_volumes_project_lifecycle ON volumes(project_id, lifecycle);

-- migrate:down

DROP INDEX IF EXISTS idx_volumes_project_lifecycle;
DROP TABLE IF EXISTS volumes;
