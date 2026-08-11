-- migrate:up

-- Phase 13 — source ทางเลือกนอกจาก GitHub: วาง Dockerfile ตรง ๆ โดยไม่ต้องเชื่อม repo
--
-- source_type บอกว่า project นี้ใช้ source แบบไหน — 'github' (ค่าเริ่มต้น, พฤติกรรมเดิมทุกอย่าง)
-- หรือ 'dockerfile' (เนื้อหาที่ผู้ใช้วางเองใน dockerfile_content)
-- ไม่ต้องมี CHECK ข้าม column เพราะ mutual-exclusivity (github fields ว่างเมื่อเป็น dockerfile และกลับกัน)
-- บังคับจากชั้น API เท่านั้น (ดู routes/dockerfile-source.ts, routes/github.ts) — ADD COLUMN ธรรมดาพอ
ALTER TABLE projects ADD COLUMN source_type TEXT NOT NULL DEFAULT 'github'
  CHECK (source_type IN ('github', 'dockerfile'));

ALTER TABLE projects ADD COLUMN dockerfile_content TEXT;

-- migrate:down

ALTER TABLE projects DROP COLUMN dockerfile_content;
ALTER TABLE projects DROP COLUMN source_type;
