-- migrate:up

-- ตาราง environment_variables — docs/database-schema.md + docs/phase-04-environment.md
-- เข้ารหัสทุกค่า (ทั้ง plain และ secret) เพื่อให้ code path เดียว
-- is_secret ควบคุมเฉพาะการแสดงผล/redaction ใน API + logs
-- AAD format: "env:<project_id>:<key>" — ผูก ciphertext กับ project+key ป้องกัน ciphertext
-- ถูกย้ายข้าม project หรือ rename key แล้วยังใช้ได้

CREATE TABLE environment_variables (
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
  UNIQUE (project_id, key)
);

CREATE INDEX idx_env_vars_project ON environment_variables(project_id);

-- migrate:down
DROP INDEX IF EXISTS idx_env_vars_project;
DROP TABLE IF EXISTS environment_variables;
