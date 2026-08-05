-- Phase 2: GitHub App integration — installations, webhook deliveries, and deploy intents
-- ดู docs/phase-02-github-app.md สำหรับรายละเอียดและ security decisions

-- migrate:up

CREATE TABLE github_installations (
  -- id ของเราเอง (ULID) — เก็บ installation_id ของ GitHub แยกต่างหาก
  id TEXT PRIMARY KEY,
  -- GitHub installation ID — อ้างอิงจาก webhook และ API
  installation_id INTEGER NOT NULL UNIQUE,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
  account_avatar_url TEXT NOT NULL,
  -- lifecycle ตาม GitHub events: installation created/suspended/deleted
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE webhook_deliveries (
  -- X-GitHub-Delivery header — ใช้เป็น PK เพื่อ idempotency (docs/threat-model.md)
  -- duplicate delivery_id = ซ้ำ = ปฏิเสธทันที ไม่ต้องประมวลผลซ้ำ
  delivery_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,            -- X-GitHub-Event
  action TEXT,                    -- payload.action (nullable)
  -- เก็บ payload หลัง verify signature เท่านั้น — ไม่เก็บก่อนตรวจ
  payload TEXT NOT NULL,
  processed_at INTEGER,           -- NULL = ยังไม่ได้ประมวลผล
  received_at INTEGER NOT NULL
);

CREATE INDEX idx_webhook_deliveries_received ON webhook_deliveries(received_at);
CREATE INDEX idx_webhook_deliveries_unprocessed ON webhook_deliveries(processed_at) WHERE processed_at IS NULL;

-- deploy_intents: สัญญาสำหรับ Phase 3 Deploy Engine
-- Phase 2 สร้างเมื่อ push event ผ่านการตรวจสอบ; Phase 3 อ่านและประมวลผล
-- ไม่ใช่ durable queue ใน Phase 2 — Phase 3 จะสร้าง deploy_jobs แยก
CREATE TABLE deploy_intents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  -- เก็บ GitHub numeric IDs สำหรับ idempotency check (ไม่อ้าง github_installations.id
  -- เพราะ installation อาจ reinstalled ได้ในอนาคต)
  installation_id INTEGER NOT NULL,
  repo_id INTEGER NOT NULL,
  branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  commit_message TEXT,            -- บรรทัดแรกเท่านั้น สำหรับแสดงผล
  commit_author TEXT,             -- display name เท่านั้น ไม่ใช่ email
  delivery_id TEXT REFERENCES webhook_deliveries(delivery_id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'picked_up', 'cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_deploy_intents_project_status ON deploy_intents(project_id, status);
CREATE INDEX idx_deploy_intents_pending ON deploy_intents(status, created_at)
  WHERE status = 'pending';

-- migrate:down
DROP INDEX IF EXISTS idx_deploy_intents_pending;
DROP INDEX IF EXISTS idx_deploy_intents_project_status;
DROP TABLE IF EXISTS deploy_intents;
DROP INDEX IF EXISTS idx_webhook_deliveries_unprocessed;
DROP INDEX IF EXISTS idx_webhook_deliveries_received;
DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS github_installations;
