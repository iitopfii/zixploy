-- GitHub App manifest flow: สร้าง GitHub App จากระบบเราเอง (แบบ Dokploy)
-- credentials ที่ได้จาก manifest conversion เก็บใน DB แบบ encrypted
-- ด้วย AES-256-GCM envelope (docs/encryption.md) — master key อยู่ filesystem เท่านั้น
--
-- แทนที่ env-var config เดิม (ZIXPLOY_GITHUB_APP_ID ฯลฯ) ทั้งหมด

-- migrate:up

CREATE TABLE github_apps (
  -- ULID ของเรา — generate ก่อน manifest flow เพื่อใช้ใน webhook URL path
  id TEXT PRIMARY KEY,
  -- GitHub numeric App ID จาก manifest conversion
  app_id INTEGER NOT NULL UNIQUE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  html_url TEXT NOT NULL,
  owner_login TEXT,
  client_id TEXT NOT NULL,
  -- encrypted ด้วย envelope v1: [version][key_id][nonce 12B][ciphertext+tag]
  -- AAD = "github_app:<id>:<field>" — ciphertext ย้ายข้าม app/field ไม่ได้
  pem_ciphertext BLOB NOT NULL,
  webhook_secret_ciphertext BLOB NOT NULL,
  client_secret_ciphertext BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- installation ผูกกับ app ที่สร้างจาก manifest flow
-- NULL = installation เก่าจาก env-var mode (orphaned หลัง migration นี้)
ALTER TABLE github_installations ADD COLUMN
  github_app_id TEXT REFERENCES github_apps(id);

CREATE INDEX idx_github_installations_app ON github_installations(github_app_id);

-- migrate:down

DROP INDEX IF EXISTS idx_github_installations_app;
ALTER TABLE github_installations DROP COLUMN github_app_id;
DROP TABLE IF EXISTS github_apps;
