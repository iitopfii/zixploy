-- Phase 1: single admin authentication, sessions และ project configuration
-- ดู docs/database-schema.md สำหรับเหตุผลของแต่ละ column

-- migrate:up
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  -- Argon2id hash เท่านั้น — ห้ามเก็บ password ในรูปแบบอื่น
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  -- เก็บ hash ของ session token ไม่เก็บ token เอง: DB หลุดแล้วสวมสิทธิ์ไม่ได้
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- บันทึกความพยายาม login ที่ล้มเหลวเพื่อ rate limit — ไม่เก็บ password ที่ลองผิด
CREATE TABLE login_attempts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  client_key TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);

CREATE INDEX idx_login_attempts_lookup ON login_attempts(client_key, attempted_at);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  -- display เท่านั้น — ชื่อ Docker resource generate จาก id (ADR-0005)
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'running', 'deploying', 'failed', 'stopped')),

  -- source (เติมจริงใน phase 2)
  installation_id TEXT,
  repo_id INTEGER,
  repo_full_name TEXT,
  branch TEXT,
  auto_deploy INTEGER NOT NULL DEFAULT 0 CHECK (auto_deploy IN (0, 1)),

  -- build/runtime configuration (ใช้จริงใน phase 3)
  dockerfile_path TEXT NOT NULL DEFAULT 'Dockerfile',
  build_context TEXT NOT NULL DEFAULT '.',
  target_stage TEXT,
  internal_port INTEGER CHECK (internal_port IS NULL OR (internal_port > 0 AND internal_port <= 65535)),
  health_check_path TEXT,
  health_check_interval_sec INTEGER NOT NULL DEFAULT 5,
  health_check_timeout_sec INTEGER NOT NULL DEFAULT 30,
  health_check_retries INTEGER NOT NULL DEFAULT 3,
  start_command TEXT,
  cpu_limit REAL,
  memory_limit_mb INTEGER,
  restart_policy TEXT NOT NULL DEFAULT 'unless-stopped'
    CHECK (restart_policy IN ('no', 'on-failure', 'always', 'unless-stopped')),
  deploy_timeout_sec INTEGER NOT NULL DEFAULT 900,

  -- soft delete: project ที่มี deployment history ต้องไม่ถูกลบจริง
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_projects_archived ON projects(archived_at);

-- migrate:down
DROP INDEX idx_projects_archived;
DROP TABLE projects;
DROP INDEX idx_login_attempts_lookup;
DROP TABLE login_attempts;
DROP INDEX idx_sessions_expires;
DROP INDEX idx_sessions_user;
DROP TABLE sessions;
DROP TABLE users;
