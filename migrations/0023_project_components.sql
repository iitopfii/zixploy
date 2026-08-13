-- migrate:up

-- Multi-container (compose-style) projects — Phase 18 · Phase A (schema foundation)
--
-- ADDITIVE ล้วน: project เดิมทุกตัวอยู่ mode='single' และวิ่ง deploy pipeline เดิม byte-for-byte
-- ตารางใหม่ + คอลัมน์ nullable ยัง "ไม่มีตัวอ่าน" จนกว่าจะเปิด mode='compose' (Phase C orchestrator)
-- จึงไม่กระทบพฤติกรรมของระบบเดิมเลย
--
-- หมายเหตุการออกแบบ: UNIQUE(project_id,key) ของ environment_variables ยังคงไว้ตามเดิมใน phase นี้
-- (component-scoped env ยังไม่มีตัวเขียน) — จะเปลี่ยนเป็น partial index สองอันตอน phase ที่เพิ่ม
-- env ระดับ component จริง เพื่อเลี่ยงการ rebuild ตารางโดยไม่จำเป็นตอนนี้

-- ── projects: โหมด + ที่มาของ component ──
ALTER TABLE projects ADD COLUMN mode TEXT NOT NULL DEFAULT 'single'
  CHECK (mode IN ('single', 'compose'));
ALTER TABLE projects ADD COLUMN components_source TEXT NOT NULL DEFAULT 'ui'
  CHECK (components_source IN ('ui', 'file'));
ALTER TABLE projects ADD COLUMN manifest_path TEXT NOT NULL DEFAULT 'zixploy.yaml';

-- ── project_components: หนึ่งแถวต่อหนึ่ง container ในโปรเจกต์ compose ──
-- คอลัมน์สะท้อน projects.* เพื่อให้ "implicit single component" map ตรงตัวได้ (Phase C)
CREATE TABLE project_components (
  id TEXT PRIMARY KEY,                 -- ULID — ใช้ตั้งชื่อ Docker resource ทุกตัว (ADR-0005)
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                  -- = network alias (DNS label) — API ตรวจ ^[a-z][a-z0-9-]{0,30}$
  role TEXT NOT NULL DEFAULT 'app'
    CHECK (role IN ('web', 'worker', 'db', 'cache', 'app', 'other')),
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('build', 'image', 'managed_ref')),

  -- source_kind='build'
  dockerfile_path TEXT,
  build_context TEXT,
  target_stage TEXT,
  -- source_kind='image'
  image_ref TEXT,
  -- source_kind='managed_ref' — อ้าง managed service (0015) ตรง ๆ ไม่สร้าง container ใหม่
  managed_service_id TEXT REFERENCES services(id),

  command TEXT,
  internal_port INTEGER
    CHECK (internal_port IS NULL OR (internal_port > 0 AND internal_port <= 65535)),
  is_web INTEGER NOT NULL DEFAULT 0 CHECK (is_web IN (0, 1)),
  web_port INTEGER,
  exposed_port INTEGER,
  health_check_path TEXT,
  health_check_interval_sec INTEGER NOT NULL DEFAULT 5,
  health_check_timeout_sec INTEGER NOT NULL DEFAULT 30,
  health_check_retries INTEGER NOT NULL DEFAULT 3,
  cpu_limit REAL,
  memory_limit_mb INTEGER,
  restart_policy TEXT NOT NULL DEFAULT 'unless-stopped'
    CHECK (restart_policy IN ('no', 'on-failure', 'always', 'unless-stopped')),
  position INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  UNIQUE (project_id, name)
);

CREATE INDEX idx_project_components_project ON project_components(project_id, position);

-- ── component_deps: DAG ของ depends_on (ลำดับ start + เงื่อนไข health) ──
CREATE TABLE component_deps (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  component_id TEXT NOT NULL REFERENCES project_components(id) ON DELETE CASCADE,
  depends_on_component_id TEXT NOT NULL REFERENCES project_components(id) ON DELETE CASCADE,
  condition TEXT NOT NULL DEFAULT 'started' CHECK (condition IN ('started', 'healthy')),
  PRIMARY KEY (component_id, depends_on_component_id)
);

CREATE INDEX idx_component_deps_project ON component_deps(project_id);

-- ── deployment_containers: หนึ่งแถวต่อ component ต่อ deployment ──
-- แทน deployments.container_id เดี่ยว (คงคอลัมน์เดิมไว้ nullable สำหรับ legacy/primary web component)
CREATE TABLE deployment_containers (
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  component_id TEXT NOT NULL REFERENCES project_components(id),
  container_id TEXT,
  image_tag TEXT,
  image_digest TEXT,
  status TEXT,
  health TEXT,
  started_at INTEGER,
  PRIMARY KEY (deployment_id, component_id)
);

CREATE INDEX idx_deployment_containers_component ON deployment_containers(component_id);

-- ── scope ต่อ component: nullable component_id (NULL = project-wide = พฤติกรรมเดิม) ──
-- ต้องสร้าง project_components ก่อน เพราะคอลัมน์เหล่านี้ REFERENCES ไปหามัน
ALTER TABLE environment_variables ADD COLUMN component_id TEXT REFERENCES project_components(id);
ALTER TABLE volumes ADD COLUMN component_id TEXT REFERENCES project_components(id);
ALTER TABLE project_domains ADD COLUMN component_id TEXT REFERENCES project_components(id);
ALTER TABLE terminal_sessions ADD COLUMN component_id TEXT REFERENCES project_components(id);

-- migrate:down

-- ลบคอลัมน์ที่อ้าง project_components ก่อน แล้วค่อยลบตารางที่ถูกอ้าง
ALTER TABLE terminal_sessions DROP COLUMN component_id;
ALTER TABLE project_domains DROP COLUMN component_id;
ALTER TABLE volumes DROP COLUMN component_id;
ALTER TABLE environment_variables DROP COLUMN component_id;

DROP INDEX IF EXISTS idx_deployment_containers_component;
DROP TABLE IF EXISTS deployment_containers;
DROP INDEX IF EXISTS idx_component_deps_project;
DROP TABLE IF EXISTS component_deps;
DROP INDEX IF EXISTS idx_project_components_project;
DROP TABLE IF EXISTS project_components;

ALTER TABLE projects DROP COLUMN manifest_path;
ALTER TABLE projects DROP COLUMN components_source;
ALTER TABLE projects DROP COLUMN mode;
