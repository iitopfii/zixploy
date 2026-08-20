-- migrate:up

-- นำเข้า container ที่มีอยู่บนเครื่องแล้ว (ไม่ได้สร้างผ่าน Zixploy) ให้กลายเป็น project ที่จัดการได้
--
-- ทำเป็นตารางของตัวเองแทนที่จะยัดเข้า service_jobs เพราะ type ของตารางนั้นมี CHECK constraint
-- (SQLite แก้ CHECK ไม่ได้ ต้อง rebuild ทั้งตาราง) — งานนี้มี lifecycle ของตัวเองอยู่แล้ว
--
-- ขั้นตอน: pending → inspected (worker อ่าน config มาให้ตรวจ) → confirmed (ผู้ใช้ยืนยัน)
--          → done (สร้าง project แล้ว) · failed ได้ทุกขั้น
--
-- **ค่าของ env ไม่ถูกเก็บในตารางนี้เด็ดขาด** — preview เก็บแค่ชื่อ key (env_keys) ส่วนค่าจริง
-- worker อ่านจาก container ตอน confirm แล้วเข้ารหัสลง environment_variables โดยตรง
-- (ค่า secret จึงไม่เคยนอนเป็น plaintext ใน DB แม้ระหว่างรอผู้ใช้กดยืนยัน)

CREATE TABLE container_imports (
  id TEXT PRIMARY KEY,                  -- ULID
  container_id TEXT NOT NULL,           -- Docker container ID ที่จะนำเข้า
  container_name TEXT NOT NULL,         -- ชื่อตอนสร้างคำขอ (ไว้แสดงผล/อ้างอิงย้อนหลัง)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'inspected', 'confirmed', 'done', 'failed')),

  -- ── ผลจาก docker inspect (เขียนโดย worker ตอน status=pending) ──
  image TEXT,
  command TEXT,
  restart_policy TEXT,
  -- JSON array ของชื่อ env key เท่านั้น เช่น ["PORT","DATABASE_URL"] — ไม่มีค่า
  env_keys TEXT,
  -- JSON: [{"hostPort":8080,"containerPort":80}]
  ports TEXT,
  -- JSON: [{"source":"myvol","target":"/data","type":"volume"|"bind","readOnly":false}]
  mounts TEXT,

  -- ── ค่าที่ผู้ใช้เลือกตอนยืนยัน ──
  project_name TEXT,
  -- project ที่สร้างขึ้นเมื่อ status='done'
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,

  failure_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_container_imports_status ON container_imports(status, created_at);

-- migrate:down

DROP INDEX IF EXISTS idx_container_imports_status;
DROP TABLE IF EXISTS container_imports;
