# ADR-0002: Deploy Worker แยก Process และผูกขาดสิทธิ์ Docker

สถานะ: Accepted (Phase 0)

## บริบท

การเข้าถึง Docker socket เทียบเท่า root บน host ขณะที่ Control API เป็นส่วนที่เผชิญ internet (ผ่าน Traefik) และรับ input ไม่น่าเชื่อถือมากที่สุด

## ตัดสินใจ

- Deploy Worker เป็น **Bun process/service แยก** จาก Control API — แชร์ workspace, database models และ types เดียวกัน แต่คนละ entrypoint คนละ service account
- **เฉพาะ worker** เข้าถึง Docker Engine; API ไม่มีสิทธิ์แตะ socket ทั้งใน dev และ production
- API สื่อสารกับ worker ทางเดียวผ่าน `deploy_jobs` ใน SQLite (ไม่มี RPC ตรง)
- Worker readiness รายงานกลับผ่าน heartbeat ใน DB — health endpoint ของ API อ่านจากตรงนั้น

## ผลที่ตามมา

- Compromise ของ API ไม่ให้สิทธิ์ Docker ทันที
- ต้องออกแบบ queue/lease ให้ recover ได้เมื่อ worker crash (ADR-0003)
- Deployment ของ platform เองมีสอง service ให้ดูแล (ยอมรับ — คุ้มกับ trust boundary)
