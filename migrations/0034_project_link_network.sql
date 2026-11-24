-- migrate:up

-- link network ต่อ project (0.1.26) — project compose ที่ตั้งชื่อ link เดียวกันเรียก component ของกันและกัน
-- ได้ด้วยชื่อ component ผ่าน Docker network ร่วม `zx-link-<ชื่อ>` (เช่น app เรียก tei/ocr ใน project ML ที่
-- deploy แยก) · NULL = ไม่ต่อ (component อยู่บน per-deployment network อย่างเดียวเหมือนเดิม)
-- รูปแบบ: a-z 0-9 และ "-" ยาว 1–40 ขึ้นต้นด้วยตัวอักษร/ตัวเลข (ตรงกับ isLinkNetworkName ใน @zixploy/shared)
ALTER TABLE projects ADD COLUMN link_network TEXT
  CHECK (link_network IS NULL OR (
    length(link_network) BETWEEN 1 AND 40
    AND link_network GLOB '[a-z0-9]*'
    AND link_network NOT GLOB '*[^a-z0-9-]*'
  ));

CREATE INDEX idx_projects_link_network ON projects(link_network) WHERE link_network IS NOT NULL;

-- migrate:down

DROP INDEX IF EXISTS idx_projects_link_network;
ALTER TABLE projects DROP COLUMN link_network;
