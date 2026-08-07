-- migrate:up

-- Resource metrics time-series — Phase 9 (server monitoring)
--
-- เก็บโดย deploy-worker เท่านั้น (ADR-0002: control-api ไม่แตะ Docker/host proc)
-- control-api อ่านจากสองตารางนี้อย่างเดียว ไม่เคยเขียน
--
-- Retention: เก็บตัวอย่างละเอียด (ทุก MONITORING.sampleIntervalMs) ย้อนหลัง 24 ชม.
-- แล้ว prune ทิ้ง — ไม่มี rollup table เพราะโจทย์คือ "ตอนนี้เกิดอะไรขึ้น" ไม่ใช่ capacity planning
-- ระยะยาว (ถ้าต้องการ trend ข้ามสัปดาห์ค่อยเพิ่ม host_metrics_hourly ทีหลังโดยไม่ต้องแก้ตารางนี้)

-- ── Host ──
-- ts เป็น PRIMARY KEY ตรง ๆ (rowid alias) ทำให้แถวเรียงตามเวลาบนดิสก์อยู่แล้ว
-- range scan ตามช่วงเวลาและ DELETE WHERE ts < cutoff จึงเร็วโดยไม่ต้องมี index เพิ่ม
--
-- Single-writer เท่านั้น (worker ตัวเดียวตาม ADR-0002) — ถ้ามี worker ซ้อนกันชั่วคราว
-- ระหว่าง deploy ตัวหลังจะ INSERT OR REPLACE ทับ sample เดียวกัน ไม่ทำให้ข้อมูลซ้ำ
CREATE TABLE host_metrics (
  ts INTEGER PRIMARY KEY,

  -- 0-100 ต่อ "ทั้งเครื่อง" (รวมทุก core แล้ว) คำนวณจาก delta ของ /proc/stat ระหว่างสองตัวอย่าง
  cpu_percent REAL NOT NULL CHECK (cpu_percent >= 0),

  mem_used_bytes  INTEGER NOT NULL CHECK (mem_used_bytes  >= 0),
  mem_total_bytes INTEGER NOT NULL CHECK (mem_total_bytes > 0),

  -- ดิสก์ของ filesystem ที่เก็บ Docker data (image/volume/workspace) ไม่ใช่ overlay ของ container
  disk_used_bytes  INTEGER NOT NULL CHECK (disk_used_bytes  >= 0),
  disk_total_bytes INTEGER NOT NULL CHECK (disk_total_bytes > 0),

  load1  REAL NOT NULL CHECK (load1  >= 0),
  load5  REAL NOT NULL CHECK (load5  >= 0),
  load15 REAL NOT NULL CHECK (load15 >= 0),

  -- จำนวน core ที่เห็น — ต้องเก็บคู่กับ load เพราะ load 4.0 บนเครื่อง 8 core กับ 2 core
  -- แปลผลต่างกันคนละเรื่อง และค่านี้เปลี่ยนได้เมื่อ resize VM
  cpu_count INTEGER NOT NULL CHECK (cpu_count > 0)
);

-- ── Container (ราย project) ──
-- PRIMARY KEY (project_id, ts) — หนึ่งตัวอย่างต่อ project ต่อรอบเก็บ
-- เรียงตาม project ก่อนแล้วค่อยเวลา ทำให้ query "กราฟของ project นี้ 1 ชม.ล่าสุด" อ่านต่อเนื่องบนดิสก์
CREATE TABLE container_metrics (
  ts         INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- container ที่วัดในตัวอย่างนี้ — เปลี่ยนได้ทุก deploy จึงเก็บไว้เพื่อแยกช่วงก่อน/หลัง deploy
  container_id TEXT NOT NULL,

  cpu_percent     REAL    NOT NULL CHECK (cpu_percent >= 0),
  mem_used_bytes  INTEGER NOT NULL CHECK (mem_used_bytes >= 0),

  -- 0 = ไม่ได้จำกัด memory (docker รายงาน limit เป็นขนาด RAM ทั้งเครื่อง — เก็บ 0 แทนเพื่อไม่ให้
  -- กราฟ % ใช้งานเทียบกับตัวเลขที่ไม่ใช่ limit จริง)
  mem_limit_bytes INTEGER NOT NULL DEFAULT 0 CHECK (mem_limit_bytes >= 0),

  restart_count INTEGER NOT NULL DEFAULT 0 CHECK (restart_count >= 0),
  running       INTEGER NOT NULL DEFAULT 1 CHECK (running IN (0, 1)),

  PRIMARY KEY (project_id, ts)
);

-- prune ลบตามเวลาข้าม project — ต้องมี index บน ts แยก เพราะ PK ขึ้นต้นด้วย project_id
CREATE INDEX idx_container_metrics_ts ON container_metrics(ts);

-- migrate:down

DROP INDEX IF EXISTS idx_container_metrics_ts;
DROP TABLE IF EXISTS container_metrics;
DROP TABLE IF EXISTS host_metrics;
