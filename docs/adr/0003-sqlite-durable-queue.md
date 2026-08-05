# ADR-0003: SQLite เป็น Durable Queue (ไม่ใช้ message broker)

สถานะ: Accepted (Phase 0)

## บริบท

Deploy jobs ต้องอยู่รอด restart, ทำครั้งละหนึ่งงานต่อ project และ recover เมื่อ worker crash — throughput ต่ำมาก (คนเดียวกด deploy)

## ตัดสินใจ

- เก็บ jobs ในตาราง `deploy_jobs` ของ SQLite เดียวกับข้อมูลหลัก
- Worker **claim ด้วย transaction + lease expiry**; heartbeat ต่ออายุ lease ระหว่างทำงาน
- Job ที่ lease หมดอายุถือว่า worker ตาย — recover/retry ได้ตาม `max_attempts`
- Coalesce pending auto-deploy: push ถี่ ๆ อัปเดต payload เป็น commit ล่าสุดแทนต่อคิวใหม่
- ไม่ใช้ Redis/RabbitMQ — เพิ่ม operational surface โดยไม่จำเป็น

## ผลที่ตามมา

- Queue กับ state อยู่ transaction เดียวกันได้ (สร้าง deployment + job แบบ atomic)
- ต้องระวัง SQLite write contention — เปิด WAL + busy_timeout และเขียนสั้น ๆ
- ถ้าอนาคตต้อง multi-node ค่อยเปลี่ยน (เป็น non-goal ที่ประกาศแล้ว)
