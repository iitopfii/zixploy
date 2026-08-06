-- migrate:up

-- Domain/hostname routing configuration สำหรับแต่ละ project
-- ทุก hostname ต้องผ่าน validateHostname() ก่อน insert/update (control-api/domains/validator.ts)
-- Traefik labels สร้างจากตารางนี้ด้วย buildTraefikLabels() — ไม่รับ raw label จากผู้ใช้ (threat-model.md)

CREATE TABLE project_domains (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- hostname ต้องผ่าน validation: lowercase, punycode, ห้าม scheme/path/query/wildcard/IP/reserved
  hostname TEXT NOT NULL UNIQUE,

  -- port ที่ container ฟัง (อาจต่างจาก project.internal_port ถ้า app ฟังหลาย port)
  internal_port INTEGER NOT NULL CHECK (internal_port BETWEEN 1 AND 65535),

  -- HTTPS configuration
  https_enabled INTEGER NOT NULL DEFAULT 1 CHECK (https_enabled IN (0, 1)),
  redirect_http  INTEGER NOT NULL DEFAULT 1 CHECK (redirect_http  IN (0, 1)),
  redirect_mode  TEXT    NOT NULL DEFAULT 'none'
    CHECK (redirect_mode IN ('none', 'www_to_root', 'root_to_www')),

  -- DNS verification status — อัปเดตโดย POST .../check
  dns_status     TEXT    NOT NULL DEFAULT 'pending'
    CHECK (dns_status IN ('pending', 'valid', 'mismatch', 'unknown')),
  dns_checked_at INTEGER,

  -- soft disable โดยไม่ต้องลบ — Traefik labels จะไม่ถูกสร้างสำหรับแถวที่ enabled = 0
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_project_domains_project_id ON project_domains(project_id);
CREATE INDEX idx_project_domains_hostname    ON project_domains(hostname);

-- migrate:down

DROP INDEX IF EXISTS idx_project_domains_hostname;
DROP INDEX IF EXISTS idx_project_domains_project_id;
DROP TABLE IF EXISTS project_domains;
