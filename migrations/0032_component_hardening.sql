-- migrate:up

-- runtime hardening ต่อ component (0.1.24) — เทียบเท่า compose: cap_drop, security_opt,
-- memswap_limit, pids_limit · ทั้งหมดเป็นการ "ลด" สิทธิ์/ทรัพยากร ไม่มีตัวไหนเพิ่มสิทธิ์ (cap-add/privileged
-- ยังถูกปฏิเสธที่ docker/safety.ts เหมือนเดิม)

-- --memory-swap (รวม RAM) · NULL = ค่าเริ่มต้นของ Docker (swap ได้เท่ากับ memory) · ต้องตั้ง memory ด้วย
ALTER TABLE project_components ADD COLUMN memory_swap_mb INTEGER
  CHECK (memory_swap_mb IS NULL OR memory_swap_mb > 0);
-- --pids-limit · NULL = 512 (ค่าเดิมของทุก container ใน zixploy)
ALTER TABLE project_components ADD COLUMN pids_limit INTEGER
  CHECK (pids_limit IS NULL OR pids_limit BETWEEN 16 AND 32768);
-- --cap-drop ALL
ALTER TABLE project_components ADD COLUMN cap_drop_all INTEGER NOT NULL DEFAULT 0
  CHECK (cap_drop_all IN (0, 1));
-- --security-opt no-new-privileges:true
ALTER TABLE project_components ADD COLUMN no_new_privileges INTEGER NOT NULL DEFAULT 0
  CHECK (no_new_privileges IN (0, 1));

-- migrate:down

ALTER TABLE project_components DROP COLUMN no_new_privileges;
ALTER TABLE project_components DROP COLUMN cap_drop_all;
ALTER TABLE project_components DROP COLUMN pids_limit;
ALTER TABLE project_components DROP COLUMN memory_swap_mb;
