-- migrate:disable-foreign-keys

-- migrate:up

-- route ตาม path + ผูก domain กับ component (compose หลาย web component)
--
-- เดิม hostname เป็น UNIQUE ทั้งระบบ → host เดียวชี้ได้ที่เดียว ทำ "sealand.example.com/api/* → api,
-- ที่เหลือ → web" ไม่ได้ · เปลี่ยนเป็น unique ต่อคู่ (hostname, path_prefix) โดย NULL = ทั้ง host
-- SQLite ถอด UNIQUE ระดับ column ไม่ได้ ต้อง rebuild ตาราง (ลำดับ create new → copy → drop → rename
-- ตาม sqlite.org/lang_altertable.html#otheralter) — ไม่มีตารางไหน REFERENCES project_domains แต่ตารางนี้
-- อ้าง projects/project_components อยู่ จึงปิด foreign_keys ระหว่าง rebuild ไว้ก่อน (runner ตรวจ
-- PRAGMA foreign_key_check ให้อีกชั้นก่อน commit)
--
-- component_id (เพิ่มใน 0023) ยังเหมือนเดิม — 0030 แค่ทำให้ worker ใช้มันจริง

CREATE TABLE project_domains_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  hostname TEXT NOT NULL,
  -- NULL = ทั้ง host · ไม่ NULL = เฉพาะ path ที่ขึ้นต้นด้วยค่านี้ (normalize เป็น "/xxx/" ที่ API เสมอ)
  path_prefix TEXT
    CHECK (path_prefix IS NULL OR (path_prefix LIKE '/%/' AND length(path_prefix) BETWEEN 3 AND 128)),
  internal_port INTEGER NOT NULL CHECK (internal_port BETWEEN 1 AND 65535),

  https_enabled INTEGER NOT NULL DEFAULT 1 CHECK (https_enabled IN (0, 1)),
  redirect_http  INTEGER NOT NULL DEFAULT 1 CHECK (redirect_http  IN (0, 1)),
  redirect_mode  TEXT    NOT NULL DEFAULT 'none'
    CHECK (redirect_mode IN ('none', 'www_to_root', 'root_to_www')),

  dns_status     TEXT    NOT NULL DEFAULT 'pending'
    CHECK (dns_status IN ('pending', 'valid', 'mismatch', 'proxied', 'unknown')),
  dns_checked_at INTEGER,

  tls_mode TEXT NOT NULL DEFAULT 'letsencrypt'
    CHECK (tls_mode IN ('letsencrypt', 'custom')),
  tls_cert_ciphertext BLOB,
  tls_key_ciphertext  BLOB,
  tls_cert_fingerprint TEXT,
  tls_cert_subject     TEXT,
  tls_cert_issuer      TEXT,
  tls_cert_hostnames   TEXT,
  tls_cert_not_before  INTEGER,
  tls_cert_not_after   INTEGER,
  tls_cert_uploaded_at INTEGER,

  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  component_id TEXT REFERENCES project_components(id),

  CHECK (
    tls_mode <> 'custom'
    OR (tls_cert_ciphertext IS NOT NULL AND tls_key_ciphertext IS NOT NULL)
  ),
  -- redirect www↔root เป็นเรื่องของทั้ง host — ตั้งที่แถว path ไม่มีความหมายและจะสร้าง router ชนกัน
  CHECK (path_prefix IS NULL OR redirect_mode = 'none')
);

INSERT INTO project_domains_new (
  id, project_id, hostname, path_prefix, internal_port,
  https_enabled, redirect_http, redirect_mode,
  dns_status, dns_checked_at,
  tls_mode, tls_cert_ciphertext, tls_key_ciphertext,
  tls_cert_fingerprint, tls_cert_subject, tls_cert_issuer, tls_cert_hostnames,
  tls_cert_not_before, tls_cert_not_after, tls_cert_uploaded_at,
  enabled, created_at, updated_at, component_id
)
SELECT
  id, project_id, hostname, NULL, internal_port,
  https_enabled, redirect_http, redirect_mode,
  dns_status, dns_checked_at,
  tls_mode, tls_cert_ciphertext, tls_key_ciphertext,
  tls_cert_fingerprint, tls_cert_subject, tls_cert_issuer, tls_cert_hostnames,
  tls_cert_not_before, tls_cert_not_after, tls_cert_uploaded_at,
  enabled, created_at, updated_at, component_id
FROM project_domains;

DROP INDEX IF EXISTS idx_project_domains_cert_expiry;
DROP INDEX IF EXISTS idx_project_domains_hostname;
DROP INDEX IF EXISTS idx_project_domains_project_id;
DROP TABLE project_domains;
ALTER TABLE project_domains_new RENAME TO project_domains;

CREATE INDEX idx_project_domains_project_id ON project_domains(project_id);
-- ifnull: UNIQUE ปกติถือว่า NULL ไม่ซ้ำกันเอง → host เดียวมี "ทั้ง host" ได้หลายแถว
CREATE UNIQUE INDEX idx_project_domains_host_path
  ON project_domains(hostname, ifnull(path_prefix, ''));
CREATE INDEX idx_project_domains_cert_expiry ON project_domains(tls_cert_not_after)
  WHERE tls_mode = 'custom';

-- migrate:down

-- กลับไป hostname UNIQUE — แถวที่มี path_prefix ไม่มีที่อยู่ใน schema เดิม (จะชน hostname) จึงถูกทิ้ง

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
    CHECK (dns_status IN ('pending', 'valid', 'mismatch', 'proxied', 'unknown')),
  dns_checked_at INTEGER,
  tls_mode TEXT NOT NULL DEFAULT 'letsencrypt'
    CHECK (tls_mode IN ('letsencrypt', 'custom')),
  tls_cert_ciphertext BLOB,
  tls_key_ciphertext  BLOB,
  tls_cert_fingerprint TEXT,
  tls_cert_subject     TEXT,
  tls_cert_issuer      TEXT,
  tls_cert_hostnames   TEXT,
  tls_cert_not_before  INTEGER,
  tls_cert_not_after   INTEGER,
  tls_cert_uploaded_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  component_id TEXT REFERENCES project_components(id),
  CHECK (
    tls_mode <> 'custom'
    OR (tls_cert_ciphertext IS NOT NULL AND tls_key_ciphertext IS NOT NULL)
  )
);

INSERT INTO project_domains_old (
  id, project_id, hostname, internal_port,
  https_enabled, redirect_http, redirect_mode,
  dns_status, dns_checked_at,
  tls_mode, tls_cert_ciphertext, tls_key_ciphertext,
  tls_cert_fingerprint, tls_cert_subject, tls_cert_issuer, tls_cert_hostnames,
  tls_cert_not_before, tls_cert_not_after, tls_cert_uploaded_at,
  enabled, created_at, updated_at, component_id
)
SELECT
  id, project_id, hostname, internal_port,
  https_enabled, redirect_http, redirect_mode,
  dns_status, dns_checked_at,
  tls_mode, tls_cert_ciphertext, tls_key_ciphertext,
  tls_cert_fingerprint, tls_cert_subject, tls_cert_issuer, tls_cert_hostnames,
  tls_cert_not_before, tls_cert_not_after, tls_cert_uploaded_at,
  enabled, created_at, updated_at, component_id
FROM project_domains
WHERE path_prefix IS NULL;

DROP INDEX IF EXISTS idx_project_domains_cert_expiry;
DROP INDEX IF EXISTS idx_project_domains_host_path;
DROP INDEX IF EXISTS idx_project_domains_project_id;
DROP TABLE project_domains;
ALTER TABLE project_domains_old RENAME TO project_domains;

CREATE INDEX idx_project_domains_project_id ON project_domains(project_id);
CREATE INDEX idx_project_domains_hostname    ON project_domains(hostname);
CREATE INDEX idx_project_domains_cert_expiry ON project_domains(tls_cert_not_after)
  WHERE tls_mode = 'custom';
