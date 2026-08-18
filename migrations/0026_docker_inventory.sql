-- migrate:up

-- Docker inventory snapshot — รายชื่อ container/image ทั้งเครื่องสำหรับหน้า "Docker" ใน dashboard
--
-- worker เป็นผู้เขียนเพียงผู้เดียว (ADR-0002): กวาด `docker ps -a` + `docker images` เป็นระยะ
-- แล้ว full-replace ทั้งตารางในธุรกรรมเดียว — ตารางนี้เป็น projection ของสถานะ Docker ล่าสุด
-- ไม่ใช่ประวัติ (ไม่มี retention/prune ให้ดูแล) · control-api อ่านอย่างเดียว
--
-- captured_at เดียวกันทั้งชุดต่อรอบกวาด — UI ใช้แสดงความสดของข้อมูล

CREATE TABLE docker_containers (
  container_id TEXT PRIMARY KEY,      -- docker ID (สั้น 12 ตัว ตาม docker ps)
  name TEXT NOT NULL,
  image TEXT NOT NULL,
  state TEXT NOT NULL,                -- running / exited / created / ...
  status TEXT NOT NULL,               -- ข้อความจาก docker เช่น "Up 2 hours (healthy)"
  ports TEXT,                         -- ข้อความ ports จาก docker ps (อาจว่าง)
  networks TEXT,
  -- container ของแพลตฟอร์มเอง (มี platform.* label หรือชื่อขึ้นต้น zx-/zxsvc-/zixploy-)
  -- แยกจาก container อื่นบนเครื่องที่ผู้ใช้รันเอง — UI ใช้ติด badge
  is_managed INTEGER NOT NULL DEFAULT 0 CHECK (is_managed IN (0, 1)),
  created_text TEXT,                  -- เวลาที่สร้าง (ข้อความจาก docker — ไว้แสดงผลเท่านั้น)
  captured_at INTEGER NOT NULL
);

CREATE TABLE docker_images (
  image_id TEXT NOT NULL,             -- docker image ID (สั้น)
  repository TEXT NOT NULL,           -- "<none>" ได้ (dangling)
  tag TEXT NOT NULL,                  -- "<none>" ได้ (dangling)
  size TEXT,                          -- ข้อความจาก docker เช่น "184MB"
  created_since TEXT,                 -- ข้อความจาก docker เช่น "2 weeks ago"
  is_managed INTEGER NOT NULL DEFAULT 0 CHECK (is_managed IN (0, 1)),
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (image_id, repository, tag)
);

-- migrate:down

DROP TABLE IF EXISTS docker_images;
DROP TABLE IF EXISTS docker_containers;
