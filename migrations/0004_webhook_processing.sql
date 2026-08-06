-- Phase 2 hardening: webhook processing state machine + deploy_intent idempotency
-- ดู docs/phase-02-github-app.md สำหรับ recovery design
--
-- ก่อนหน้า: webhook_deliveries มีแค่ processed_at (NULL = ยังไม่ process)
-- ใหม่: state machine received→processing→processed|failed ป้องกัน lost/stuck deliveries
-- ก่อนหน้า: deploy_intents ไม่มี DB-level unique constraint ต่อ delivery
-- ใหม่: UNIQUE INDEX บน (project_id, delivery_id) ป้องกัน intent ซ้ำแม้ retry หลายครั้ง

-- migrate:up

-- Webhook processing state machine
-- received  = inserted แต่ยังไม่ได้ claim lease
-- processing = handler กำลัง claim lease (lease หมดอายุใน 30 วินาที)
-- processed  = สำเร็จ ไม่ต้อง retry
-- failed     = ล้มเหลว; attempt_count < MAX → retry ได้เมื่อ GitHub redeliver

ALTER TABLE webhook_deliveries ADD COLUMN
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processing', 'processed', 'failed'));

ALTER TABLE webhook_deliveries ADD COLUMN
  attempt_count INTEGER NOT NULL DEFAULT 0;

-- Error code จาก AppError.code — เก็บไว้ debug
ALTER TABLE webhook_deliveries ADD COLUMN
  last_error_code TEXT;

-- Timestamp เมื่อ handler เริ่ม claim lease — ใช้ detect stale leases
ALTER TABLE webhook_deliveries ADD COLUMN
  processing_started_at INTEGER;

-- Unix ms เมื่อ retry ได้ — ใช้สำหรับ scheduled retry ใน Phase 3
ALTER TABLE webhook_deliveries ADD COLUMN
  next_retry_at INTEGER;

-- Backfill: deliveries ที่ processed_at ไม่ NULL ถือว่า processed แล้ว
UPDATE webhook_deliveries
  SET status = 'processed', attempt_count = 1
  WHERE processed_at IS NOT NULL;

-- Index: ค้นหา stale processing leases ที่ต้อง recover
CREATE INDEX idx_webhook_deliveries_processing
  ON webhook_deliveries(status, processing_started_at)
  WHERE status = 'processing';

-- Index: ค้นหา failed deliveries ที่ eligible for retry
CREATE INDEX idx_webhook_deliveries_retry
  ON webhook_deliveries(status, next_retry_at, attempt_count)
  WHERE status = 'failed';

-- DB-level idempotency: project เดียวกัน + delivery เดียวกัน → intent เพียง 1 ชิ้น
-- Partial index (WHERE delivery_id IS NOT NULL) เพราะ delivery_id เป็น nullable
CREATE UNIQUE INDEX idx_deploy_intents_project_delivery
  ON deploy_intents(project_id, delivery_id)
  WHERE delivery_id IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS idx_deploy_intents_project_delivery;
DROP INDEX IF EXISTS idx_webhook_deliveries_retry;
DROP INDEX IF EXISTS idx_webhook_deliveries_processing;
-- DROP COLUMN ต้องเรียงจากใหม่ไปเก่า; SQLite 3.35+ รองรับ ADD/DROP COLUMN
ALTER TABLE webhook_deliveries DROP COLUMN next_retry_at;
ALTER TABLE webhook_deliveries DROP COLUMN processing_started_at;
ALTER TABLE webhook_deliveries DROP COLUMN last_error_code;
ALTER TABLE webhook_deliveries DROP COLUMN attempt_count;
ALTER TABLE webhook_deliveries DROP COLUMN status;
