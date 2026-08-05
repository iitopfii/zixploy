# Product Requirements — MVP

สถานะ: **ตรึงแล้ว (Phase 0)** — การเปลี่ยน scope หลังจากนี้ต้องบันทึกเป็น ADR

## Persona

**Admin (คนเดียว)** — นักพัฒนาที่เช่า VPS/เซิร์ฟเวอร์ Linux เครื่องเดียว ต้องการ deploy โปรเจกต์จาก GitHub โดยไม่ต้องเขียน CI/CD หรือจัดการ Nginx/certbot เอง

## User Stories

### Source & Deploy

- ในฐานะ admin ฉันเชื่อม GitHub App กับ account/organization ของฉัน แล้วเลือก private repository และ branch ให้ project ได้
- ในฐานะ admin เมื่อฉัน push ไป branch ที่กำหนด ระบบสร้าง deployment ใหม่ให้อัตโนมัติหนึ่งงานต่อ push (auto deploy เปิด/ปิดได้)
- ในฐานะ admin ฉันกด deploy เองได้ทุกเมื่อ และ redeploy commit เดิมซ้ำได้
- ในฐานะ admin เมื่อ build ล้มเหลว เว็บรุ่นที่รันอยู่ต้องไม่ดับ และฉันเห็นสาเหตุจาก build log
- ในฐานะ admin ฉัน rollback กลับไป deployment ที่สำเร็จก่อนหน้าได้อย่างน้อยหนึ่ง revision
- ในฐานะ admin ฉัน restart หรือ stop service ได้จาก dashboard

### Configuration

- ในฐานะ admin ฉันตั้ง Dockerfile path, build context, internal port, health check และ resource limits ต่อ project ได้
- ในฐานะ admin ฉันจัดการ environment variables ได้ทั้งแบบ plain และ secret โดย secret ไม่ถูกแสดงกลับ
- ในฐานะ admin ฉัน import ไฟล์ `.env` แล้วเห็น preview ก่อนบันทึก

### Domains & HTTPS

- ในฐานะ admin ฉันเพิ่มหลาย domain ให้หนึ่ง project และระบบออก HTTPS certificate ให้อัตโนมัติ
- ในฐานะ admin ฉันเห็นว่า DNS ชี้มาถูกหรือยัง และ certificate อยู่สถานะไหน

### Observability

- ในฐานะ admin ฉันดู build log ของแต่ละ deployment แบบ live และย้อนหลังได้
- ในฐานะ admin ฉันดู runtime log ของ container แบบ live ได้
- ในฐานะ admin ฉันเห็นสถานะ project ทั้งหมด (`running`, `deploying`, `failed`, `stopped`) ในหน้าเดียว

### Data

- ในฐานะ admin ฉันสร้าง Docker named volume และ mount เข้า path ที่กำหนดได้
- ในฐานะ admin การ redeploy/rollback ต้องไม่ทำข้อมูลใน volume หาย
- ในฐานะ admin การลบ volume ต้องผ่านการยืนยันชัดเจน และลบไม่ได้ถ้ายังถูกใช้งาน

### Platform Operations

- ในฐานะ admin ฉัน login ด้วย password และ session หมดอายุเองได้
- ในฐานะ admin เมื่อเซิร์ฟเวอร์ restart ระบบต้องกลับมาพร้อม configuration, queue และ certificates ครบ
- ในฐานะ admin ฉันมี runbook สำหรับ backup/restore ทั้งระบบ

## Non-Goals (รุ่นแรก)

รายการนี้คือสิ่งที่ **จงใจไม่ทำ** — เพิ่มได้ภายหลังแต่ต้องไม่ล็อก schema/architecture ปัจจุบันให้ทำไม่ได้:

| Non-goal | เหตุผล |
|---|---|
| Multi-node / Kubernetes / Swarm | scope คือ single Docker host |
| Docker Compose หลาย service ต่อ project | หนึ่ง service ต่อ project พอสำหรับ MVP |
| Preview deployments ต่อ PR | เพิ่ม complexity ของ routing/cleanup มาก |
| Teams, RBAC, multi-user | single admin เท่านั้น |
| Managed databases / marketplace | ผู้ใช้รัน database เป็น project + volume เองได้ |
| Horizontal scaling / autoscaling | single container ต่อ project |
| Web terminal เข้า container | ความเสี่ยงสูง ไม่คุ้มใน MVP |
| Arbitrary host bind mounts | อันตรายต่อ host — named volumes เท่านั้น |
| Custom Traefik config จากผู้ใช้ | proxy config ต้อง generate จากระบบเท่านั้น |
| Billing / usage metering | ไม่มีผู้ใช้หลายคน |
| Buildpacks / Nixpacks | Dockerfile-based เท่านั้นในรุ่นแรก |

## เกณฑ์ความสำเร็จระดับผลิตภัณฑ์

ดู "Definition of Done ระดับผลิตภัณฑ์" ใน [docs/README.md](README.md) — ทุกข้อต้องผ่านก่อนประกาศ MVP
