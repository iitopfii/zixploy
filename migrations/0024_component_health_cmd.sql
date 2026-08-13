-- migrate:up

-- Phase 18 · Phase F — Docker-native healthcheck ต่อ component (สำหรับ depends_on แบบ condition='healthy')
--
-- ADDITIVE ล้วน: เพิ่ม health_cmd (nullable) ให้ตั้งคำสั่ง HEALTHCHECK ใน container ได้ต่อ component
-- worker orchestrator อ่านค่านี้ไปตั้ง `docker create --health-cmd` แล้ว gate dependent ที่ระบุ
-- condition='healthy' โดยรอ State.Health.Status='healthy' ของ dependency ก่อน start ตัวที่ขึ้นกับมัน
--
-- ว่างไว้ (NULL) = ไม่ตั้ง healthcheck (พฤติกรรมเดิม — dependent ที่ระบุ 'healthy' จะ fallback เป็น
-- 'started' พร้อม log เตือน) · reuse คอลัมน์ health_check_interval_sec/timeout_sec/retries ที่มีอยู่แล้ว

ALTER TABLE project_components ADD COLUMN health_cmd TEXT;

-- migrate:down

ALTER TABLE project_components DROP COLUMN health_cmd;
