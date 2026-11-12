-- migrate:up

-- credential ของ container registry (เช่น ghcr.io) สำหรับ pull image ที่เป็น private
--
-- 1 แถวต่อ registry host — worker เลือกแถวจาก host ของ image ref ตอน pull (ดู imageRegistry ใน
-- @zixploy/shared) แล้วเขียน DOCKER_CONFIG ชั่วคราวต่อการ pull ครั้งเดียว — ไม่ docker login ค้างไว้
-- บนเครื่อง credential จึงไม่หลุดไปให้ deploy ของโปรเจกต์อื่นหรือ shell บน host ใช้ได้
--
-- password_ciphertext = envelope AES-256-GCM (AAD "registry:<id>") — API ไม่คืน plaintext เด็ดขาด

CREATE TABLE registry_credentials (
  id TEXT PRIMARY KEY,
  -- host ล้วน ๆ (lowercase, อาจมี :port) — Docker Hub เก็บเป็น 'docker.io'
  registry TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  password_ciphertext BLOB NOT NULL,
  -- worker อัปเดตทุกครั้งที่ใช้ pull สำเร็จ — UI ใช้บอกว่า credential ไหนยังถูกใช้อยู่
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- migrate:down

DROP TABLE IF EXISTS registry_credentials;
