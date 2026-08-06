-- Phase 8 M2: general reconciliation loop — projects.degraded_at
-- (active container หายไปจาก Docker ทั้งที่ project ควร running อยู่ — ดู docs/phase-08-production.md
-- "Reconciliation": "Active container หาย → mark degraded และเสนอ redeploy")
--
-- ใช้ nullable timestamp แยกจาก `status` แทนการเพิ่มค่าใน CHECK(status IN (...)) ตั้งใจ:
-- projects.id ถูกอ้างอิงจากหลายตาราง (deployments, deploy_jobs, domains, volumes, env vars ฯลฯ) ผ่าน
-- FOREIGN KEY ที่เปิด enforcement ไว้ (PRAGMA foreign_keys=ON ใน connection.ts) — การแก้ CHECK ต้อง
-- rebuild ตาราง projects ทั้งก้อนซึ่งจะทำให้ FK ของตารางลูกทั้งหมดเสีย (SQLite ผูก FK ใหม่ตาม
-- "ชื่อ" ตอน RENAME ไม่ใช่ตอน CREATE TABLE ซ้ำชื่อเดิม) และ PRAGMA foreign_keys ก็เปลี่ยนระหว่าง
-- transaction ที่ migration runner เปิดไว้ไม่ได้ (SQLite: no-op ถ้ามี transaction ค้างอยู่)
-- degraded_at (ควบคู่กับ status='running' เดิม) จึงปลอดภัยกว่ามากสำหรับ MVP นี้ — ไม่แตะ schema เดิมเลย

-- migrate:up

ALTER TABLE projects ADD COLUMN degraded_at INTEGER;

-- migrate:down

ALTER TABLE projects DROP COLUMN degraded_at;
