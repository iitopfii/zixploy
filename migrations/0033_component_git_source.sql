-- migrate:up

-- repo/branch แยกต่อ build component (0.1.25) — โปรเจกต์ compose ที่โค้ดอยู่หลาย repo (เช่น backend กับ
-- frontend) อยู่ในโปรเจกต์เดียวได้ จึงยังคุยกันผ่าน DNS ภายใน (http://api:3001) เหมือน compose เดิม
-- NULL ทั้งสามช่อง = ใช้ source ของ project (พฤติกรรมเดิม) · ตั้งได้เฉพาะ source_kind='build'
-- repo_installation_id = github_installations.id (ULID ภายใน แบบเดียวกับ projects.installation_id)

ALTER TABLE project_components ADD COLUMN repo_installation_id TEXT
  CHECK (repo_installation_id IS NULL OR source_kind = 'build');
ALTER TABLE project_components ADD COLUMN repo_full_name TEXT
  CHECK (repo_full_name IS NULL OR length(repo_full_name) BETWEEN 3 AND 200);
-- ต้องตั้งครบสามช่องหรือว่างทั้งสาม — ตรวจไว้ที่คอลัมน์สุดท้ายเพราะอ้างถึงคอลัมน์ก่อนหน้าได้แล้ว
ALTER TABLE project_components ADD COLUMN repo_branch TEXT
  CHECK (
    (repo_installation_id IS NULL AND repo_full_name IS NULL AND repo_branch IS NULL)
    OR (repo_installation_id IS NOT NULL AND repo_full_name IS NOT NULL AND repo_branch IS NOT NULL
        AND length(repo_branch) BETWEEN 1 AND 255)
  );

-- commit ที่ build จริงของ component ที่มี repo ของตัวเอง — JSON {"<component id>": "<sha>"} · worker
-- เขียนหลัง resolve branch → commit แล้ว · redeploy อ่านกลับไป build commit เดิมเป๊ะ
ALTER TABLE deployments ADD COLUMN component_commits TEXT
  CHECK (component_commits IS NULL OR json_valid(component_commits));

-- migrate:down

ALTER TABLE deployments DROP COLUMN component_commits;
ALTER TABLE project_components DROP COLUMN repo_branch;
ALTER TABLE project_components DROP COLUMN repo_full_name;
ALTER TABLE project_components DROP COLUMN repo_installation_id;
