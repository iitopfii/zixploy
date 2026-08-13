-- migrate:up

-- Phase 18 · Phase F — component-scoped environment variables
--
-- เดิม UNIQUE(project_id, key) ระดับตารางบังคับให้ key ไม่ซ้ำทั้งโปรเจกต์ — บล็อกไม่ให้ตั้ง env
-- ชื่อเดียวกันต่าง component ได้ · rebuild ตารางเพื่อเปลี่ยนเป็น partial unique index สองอัน:
--   - project-scoped (component_id IS NULL):     UNIQUE(project_id, key)
--   - component-scoped (component_id IS NOT NULL): UNIQUE(project_id, component_id, key)
-- ทำให้ key เดียวกันอยู่ได้ทั้งระดับ project และแยกต่อ component (component override project ตอน inject)
--
-- + เพิ่ม ON DELETE CASCADE ให้ component_id: ลบ component แล้ว env ที่ผูกกับมันหายตาม
-- (เดิม 0023 เพิ่ม component_id แบบไม่มี cascade — ตอนนั้นยังไม่มีตัวเขียน component-scoped)
--
-- ปลอดภัยใน transaction เดียวของ migration: ไม่มีตารางไหน FK มาที่ environment_variables
-- (มีแต่ FK ออกไป projects/project_components ซึ่ง data ที่ copy มายังครบถ้วน)

CREATE TABLE environment_variables_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL,
  value_ciphertext BLOB NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL DEFAULT 'runtime'
    CHECK (scope IN ('runtime', 'build', 'both')),
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  component_id TEXT REFERENCES project_components(id) ON DELETE CASCADE
);

INSERT INTO environment_variables_new
  (id, project_id, key, value_ciphertext, is_secret, scope, enabled, version, created_at, updated_at, component_id)
  SELECT id, project_id, key, value_ciphertext, is_secret, scope, enabled, version, created_at, updated_at, component_id
    FROM environment_variables;

DROP TABLE environment_variables;
ALTER TABLE environment_variables_new RENAME TO environment_variables;

CREATE INDEX idx_env_vars_project ON environment_variables(project_id);
CREATE UNIQUE INDEX idx_env_vars_project_key
  ON environment_variables(project_id, key) WHERE component_id IS NULL;
CREATE UNIQUE INDEX idx_env_vars_component_key
  ON environment_variables(project_id, component_id, key) WHERE component_id IS NOT NULL;

-- migrate:down

-- กู้กลับเป็นตารางที่มี UNIQUE(project_id, key) ระดับตาราง + component_id ไม่มี cascade (สถานะหลัง 0023)
-- หมายเหตุ: ถ้ามี component-scoped rows ที่ key ชนกันข้าม component อยู่จริง down จะ fail ที่ UNIQUE
-- (down เป็น emergency path — ควรรันตอนไม่มี data ที่ขัดกับ schema เดิม)

CREATE TABLE environment_variables_old (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL,
  value_ciphertext BLOB NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL DEFAULT 'runtime'
    CHECK (scope IN ('runtime', 'build', 'both')),
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  component_id TEXT REFERENCES project_components(id),
  UNIQUE (project_id, key)
);

INSERT INTO environment_variables_old
  (id, project_id, key, value_ciphertext, is_secret, scope, enabled, version, created_at, updated_at, component_id)
  SELECT id, project_id, key, value_ciphertext, is_secret, scope, enabled, version, created_at, updated_at, component_id
    FROM environment_variables;

DROP TABLE environment_variables;
ALTER TABLE environment_variables_old RENAME TO environment_variables;

CREATE INDEX idx_env_vars_project ON environment_variables(project_id);
