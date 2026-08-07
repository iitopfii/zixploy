-- Phase 5 M5: custom TLS certificate + Cloudflare proxy support
-- docs/phase-05-domains.md "Certificate Management"
--
-- 2 เรื่องที่ทำพร้อมกันเพราะแตะ CHECK constraint เดียวกัน (SQLite แก้ CHECK ตรง ๆ ไม่ได้
-- ต้อง rebuild ตาราง — ทำทีเดียวดีกว่าแยก migration แล้ว rebuild สองรอบ):
--
-- 1. tls_mode: 'letsencrypt' (ACME อัตโนมัติ เดิม) | 'custom' (ผู้ใช้อัปโหลด PEM เอง)
--    cert/key เก็บเป็น ciphertext เสมอ (AES-256-GCM เหมือน environment_variables)
--    AAD: "domain_tls:<domain_id>:cert" และ "domain_tls:<domain_id>:key"
--    — ย้าย ciphertext ข้าม domain หรือสลับ field cert↔key แล้ว decrypt ไม่ได้
--
-- 2. dns_status เพิ่มค่า 'proxied': domain resolve เป็น Cloudflare edge IP
--    ไม่ใช่ origin IP ของ server — ตั้งใจ (DDoS protection) ไม่ใช่ตั้ง DNS ผิด
--    จึงต้องแยกจาก 'mismatch' ที่หมายถึง "ชี้ผิดที่จริง ๆ"

-- migrate:up

CREATE TABLE project_domains_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  hostname TEXT NOT NULL UNIQUE,
  internal_port INTEGER NOT NULL CHECK (internal_port BETWEEN 1 AND 65535),

  https_enabled INTEGER NOT NULL DEFAULT 1 CHECK (https_enabled IN (0, 1)),
  redirect_http  INTEGER NOT NULL DEFAULT 1 CHECK (redirect_http  IN (0, 1)),
  redirect_mode  TEXT    NOT NULL DEFAULT 'none'
    CHECK (redirect_mode IN ('none', 'www_to_root', 'root_to_www')),

  -- 'proxied' = resolve เป็น Cloudflare IP (ปกติ ไม่ใช่ error) ต่างจาก 'mismatch' ที่ชี้ผิดจริง
  dns_status     TEXT    NOT NULL DEFAULT 'pending'
    CHECK (dns_status IN ('pending', 'valid', 'mismatch', 'proxied', 'unknown')),
  dns_checked_at INTEGER,

  -- ── TLS configuration (M5) ────────────────────────────────────────────────
  tls_mode TEXT NOT NULL DEFAULT 'letsencrypt'
    CHECK (tls_mode IN ('letsencrypt', 'custom')),

  -- ciphertext เท่านั้น — API ห้ามคืน plaintext (คืนแค่ metadata: fingerprint/expiry/hostnames)
  tls_cert_ciphertext BLOB,
  tls_key_ciphertext  BLOB,

  -- metadata ที่ derive จาก cert ตอนอัปโหลด — เก็บ plaintext ได้ (ไม่ใช่ความลับ)
  -- ใช้แสดงใน UI และเตือนก่อนหมดอายุโดยไม่ต้อง decrypt
  tls_cert_fingerprint TEXT,
  tls_cert_subject     TEXT,
  tls_cert_issuer      TEXT,
  tls_cert_hostnames   TEXT,     -- JSON array ของ CN + SAN
  tls_cert_not_before  INTEGER,  -- epoch ms
  tls_cert_not_after   INTEGER,  -- epoch ms
  tls_cert_uploaded_at INTEGER,

  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- tls_mode='custom' ต้องมี cert+key ครบคู่เสมอ — กัน state ครึ่ง ๆ ที่ทำให้ Traefik
  -- โหลด config ไม่ได้แล้ว domain อื่นในไฟล์เดียวกันพังตาม
  CHECK (
    tls_mode <> 'custom'
    OR (tls_cert_ciphertext IS NOT NULL AND tls_key_ciphertext IS NOT NULL)
  )
);

INSERT INTO project_domains_new (
  id, project_id, hostname, internal_port,
  https_enabled, redirect_http, redirect_mode,
  dns_status, dns_checked_at, enabled, created_at, updated_at
)
SELECT
  id, project_id, hostname, internal_port,
  https_enabled, redirect_http, redirect_mode,
  dns_status, dns_checked_at, enabled, created_at, updated_at
FROM project_domains;

DROP INDEX IF EXISTS idx_project_domains_hostname;
DROP INDEX IF EXISTS idx_project_domains_project_id;
DROP TABLE project_domains;
ALTER TABLE project_domains_new RENAME TO project_domains;

CREATE INDEX idx_project_domains_project_id ON project_domains(project_id);
CREATE INDEX idx_project_domains_hostname    ON project_domains(hostname);
-- cert expiry sweep (เตือนก่อนหมดอายุ) อ่านเฉพาะ custom cert เท่านั้น
CREATE INDEX idx_project_domains_cert_expiry ON project_domains(tls_cert_not_after)
  WHERE tls_mode = 'custom';

-- migrate:down

CREATE TABLE project_domains_old (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL UNIQUE,
  internal_port INTEGER NOT NULL CHECK (internal_port BETWEEN 1 AND 65535),
  https_enabled INTEGER NOT NULL DEFAULT 1 CHECK (https_enabled IN (0, 1)),
  redirect_http  INTEGER NOT NULL DEFAULT 1 CHECK (redirect_http  IN (0, 1)),
  redirect_mode  TEXT    NOT NULL DEFAULT 'none'
    CHECK (redirect_mode IN ('none', 'www_to_root', 'root_to_www')),
  dns_status     TEXT    NOT NULL DEFAULT 'pending'
    CHECK (dns_status IN ('pending', 'valid', 'mismatch', 'unknown')),
  dns_checked_at INTEGER,
  enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 'proxied' ไม่มีใน schema เก่า — map กลับเป็น 'unknown' (ยังไม่ verify) ไม่ใช่ 'valid'
INSERT INTO project_domains_old (
  id, project_id, hostname, internal_port,
  https_enabled, redirect_http, redirect_mode,
  dns_status, dns_checked_at, enabled, created_at, updated_at
)
SELECT
  id, project_id, hostname, internal_port,
  https_enabled, redirect_http, redirect_mode,
  CASE WHEN dns_status = 'proxied' THEN 'unknown' ELSE dns_status END,
  dns_checked_at, enabled, created_at, updated_at
FROM project_domains;

DROP INDEX IF EXISTS idx_project_domains_cert_expiry;
DROP INDEX IF EXISTS idx_project_domains_hostname;
DROP INDEX IF EXISTS idx_project_domains_project_id;
DROP TABLE project_domains;
ALTER TABLE project_domains_old RENAME TO project_domains;

CREATE INDEX idx_project_domains_project_id ON project_domains(project_id);
CREATE INDEX idx_project_domains_hostname    ON project_domains(hostname);
