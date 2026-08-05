# ADR-0005: ULID Public IDs, Generated Names และ Ownership Labels

สถานะ: Accepted (Phase 0)

## บริบท

ชื่อ Docker resource และ public ID เปลี่ยนภายหลังยากที่สุด — ผูกกับ resource ที่รันอยู่จริงบนเครื่องผู้ใช้

## ตัดสินใจ

- Public ID ทุก entity เป็น **ULID** (sortable ตามเวลา, ไม่เดาได้ง่ายแบบ auto-increment, ปลอดภัยใน URL)
- ไม่เปิดเผย SQLite row ID ออกนอกระบบ
- ชื่อ Docker resource **generate จาก immutable ID เท่านั้น** ไม่ใช้ user input (เช่น project name):
  - Image `zixploy/<project-id>:<sha7>-<deployment-id>`, Container `zx-<project-id>-<deployment-id>`, Volume `zxvol-<project-id>-<volume-id>`, Network `zixploy-proxy`
- ทุก resource ติด labels `platform.managed=true`, `platform.project_id=...`, (`platform.deployment_id` / `platform.volume_id`)
- Cleanup/reconciler เลือก resource จาก labels เท่านั้น และตรวจ ID ซ้ำก่อน destructive action

## ผลที่ตามมา

- Rename project ไม่กระทบ Docker resources
- Resource แปลกปลอมบน host ไม่มีวันถูก platform ลบ
- ชื่อ container อ่านโดยมนุษย์ยากขึ้นเล็กน้อย — ชดเชยด้วย labels + dashboard
