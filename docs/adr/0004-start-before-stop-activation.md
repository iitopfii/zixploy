# ADR-0004: Start-Before-Stop Activation

สถานะ: Accepted (Phase 0)

## บริบท

Build/deploy ที่ล้มเหลวต้องไม่ทำให้รุ่นที่รันอยู่ดับ (product requirement หลัก)

## ตัดสินใจ

MVP ใช้ **start-before-stop**:

1. Container เดิมรับ traffic ต่อไประหว่าง build
2. สร้าง candidate container ใหม่ → ต้องผ่าน health check ก่อน
3. สลับ route (Traefik labels) ไป candidate
4. รอ drain period แล้วจึงหยุด container เดิม
5. Candidate ล้มเหลว = ลบ candidate, route/container เดิมไม่ถูกแตะ

ข้อยกเว้น: project ที่ mount volume แบบ `single-writer` ใช้ stop-before-start พร้อมแสดง downtime warning (Phase 7)

## ทางเลือกที่ปัดตก

- Blue-green เต็มรูปแบบ / หลาย replica: เกิน scope single container ต่อ project
- Stop-before-start เป็น default: มี downtime ทุก deploy — ยอมรับไม่ได้

## ผลที่ตามมา

- ช่วงสั้น ๆ มีสอง container รันพร้อมกัน — ต้องเผื่อ RAM และระวัง volume ที่ไม่ shared-safe
- ต้องมี health check ที่กำหนดได้ต่อ project ตั้งแต่ Phase 3
