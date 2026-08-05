# Phase 6 — Build Logs, Runtime Logs และ Observability

## เป้าหมาย

ให้ Admin เห็นความคืบหน้า deploy และตรวจปัญหา container แบบ live โดยควบคุมการใช้ disk และป้องกัน secret leakage

## Log Types

### Build Logs

- ผูกกับ deployment ID
- รวม clone/build/start/health-check events
- มี timestamp, stream (`stdout`/`stderr`) และ sequence number
- Persist เพื่อเปิดย้อนหลังได้ตาม retention

### Runtime Logs

- อ่านจาก Docker logging driver
- Stream stdout/stderr ของ active หรือ historical container ที่ยังอยู่
- ใน MVP ไม่จำเป็นต้อง index ทุกบรรทัดลง SQLite
- เก็บ cursor/timestamp สำหรับ resume stream

### Control Plane Logs

- Structured JSON สำหรับ operator
- request ID, project ID และ deployment ID
- ไม่แสดงใน project logs หากเป็นข้อมูลภายใน/security-sensitive

## Streaming Design

- Server-Sent Events endpoint ผ่าน Elysia
- Client reconnect ด้วย `Last-Event-ID`
- Heartbeat เพื่อผ่าน reverse proxy timeout
- Backpressure และ per-client buffer limit
- จำกัดจำนวน concurrent streams ต่อ session/project
- เมื่อ client ช้า ให้ตัด connection และให้ reconnect แทนใช้ memory ไม่จำกัด
- ปิด SSE connection อย่างสะอาดเมื่อ Bun process shutdown หรือ session หมดอายุ

## API Surface

```text
GET /api/v1/deployments/:id/logs
GET /api/v1/deployments/:id/logs/stream
GET /api/v1/projects/:id/runtime-logs
GET /api/v1/projects/:id/runtime-logs/stream
GET /api/v1/deployments/:id/logs/download
```

## Dashboard

- Tab แยก Build Logs และ Runtime Logs
- Live/follow mode
- Pause/resume โดยไม่หยุด server stream ถาวร
- Search/filter stdout/stderr
- Download build log ที่ผ่าน redaction
- Copy selected lines
- Auto-scroll เปิด/ปิด
- แสดง reconnect และ container unavailable state

## Retention และ Disk Safety

- Docker log rotation เช่น max-size/max-file
- Build log retention ตามวันและจำนวน deployment
- Background cleanup พร้อม disk watermark
- เมื่อ disk ต่ำ ให้หยุดรับ build ใหม่ก่อนกระทบ active containers
- Dashboard แสดง disk pressure
- ห้ามเก็บ log blob ขนาดใหญ่ใน SQLite transaction เดียว

## Redaction Pipeline

```text
Process output
→ Normalize chunks/lines
→ Redact secrets and credential patterns
→ Persist safe log
→ Stream to clients
```

ต้องรองรับ secret ที่ถูกแบ่งข้าม output chunks โดยมี bounded overlap buffer

## งานดำเนินการ

- [ ] สร้าง build log writer พร้อม sequence IDs
- [ ] สร้าง Docker runtime log adapter
- [ ] สร้าง SSE endpoints/reconnect logic
- [ ] ใช้ centralized secret redactor ก่อน persist/stream
- [ ] สร้าง Logs UI
- [ ] ตั้ง Docker log rotation
- [ ] สร้าง retention/cleanup/disk monitor
- [ ] เพิ่ม metrics ขั้นต่ำ: queue depth, deploy duration, failures, disk usage

## การทดสอบ

- Stream log ต่อเนื่องและ reconnect แล้วไม่ข้าม/ซ้ำอย่างมีนัยสำคัญ
- Log ปริมาณมากไม่ทำ API/worker memory โตไม่จำกัด
- Secret ทั้งบรรทัดและข้าม chunk ถูกปิดบัง
- Container restart/removed แสดงสถานะถูกต้อง
- Retention ลบเฉพาะ log ที่หมดอายุ
- Disk pressure ป้องกัน build ใหม่แต่ไม่หยุด active app

## Exit Criteria

- Build และ runtime logs เปิดย้อนหลัง/live ได้
- Secret redaction tests ผ่าน
- Log rotation และ retention ทำงานจริง
- ระบบอยู่รอดเมื่อ log เร็วหรือ client ช้า
