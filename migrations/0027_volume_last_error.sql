-- migrate:up

-- Volume lifecycle UX — บทเรียนจากเหตุการณ์จริง 2026-08-20
--
-- ADDITIVE ล้วน: เพิ่ม last_error (nullable) เก็บสาเหตุล่าสุดที่ reconciler เจอ เพื่อให้
-- dashboard แสดงข้อความจริงจาก server แทน hardcode ตาม lifecycle — ผู้ใช้เคยเห็นแค่
-- "รอ worker ลบ Docker volume จริง…" ค้างตลอดกาลทั้งที่สาเหตุจริงคือ VOLUME_IN_USE
-- (container ที่รันอยู่ยัง mount อยู่ ต้อง redeploy ก่อน) โดยไม่มีทางรู้
--
-- NULL = ไม่มี error ค้าง (สถานะปกติ) · reconciler ใน worker เป็นผู้เขียน/ล้างค่านี้เท่านั้น

ALTER TABLE volumes ADD COLUMN last_error TEXT;

-- migrate:down

ALTER TABLE volumes DROP COLUMN last_error;
