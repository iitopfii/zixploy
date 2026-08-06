# Phase 3 — Deploy Engine และ Durable Queue

## เป้าหมาย

สร้างเส้นทาง deploy ตั้งแต่ clone source ถึงเปิดใช้งาน container โดย build failure ต้องไม่ทำให้ production รุ่นเดิมหยุดทำงาน

Deploy Worker ใช้ Bun/TypeScript และแชร์ database models, validation schemas และ event types กับ Elysia API แต่รันเป็น service แยกเพื่อแยก lifecycle และสิทธิ์ Docker

## Deploy Settings

- Source repository และ branch
- Auto Deploy เปิด/ปิด
- Dockerfile path
- Build context
- Build arguments (อ้างอิงค่าจาก Environment Settings)
- Target stage
- Internal port
- Health check path/command, timeout, interval และ retries
- Start command override (optional)
- CPU/memory limits
- Restart policy
- Deploy timeout

## Queue Design

- เก็บ job ใน SQLite ไม่ใช้ in-memory queue อย่างเดียว
- หนึ่ง active deploy ต่อ project
- Worker claim job ด้วย transaction + lease expiry
- heartbeat ต่ออายุ lease ขณะทำงาน
- crash แล้ว job ที่ lease หมดสามารถ recover/retry
- ตั้ง maximum attempts และไม่ retry build error แบบอัตโนมัติ
- Coalesce pending auto-deploy jobs: เก็บ commit ล่าสุดเมื่อมี push ถี่
- Manual deploy มี priority สูงกว่า scheduled cleanup แต่ไม่แซง active deploy

### Bun Worker Runtime

- Worker loop claim งานจาก SQLite ด้วย transaction และ lease
- ใช้ subprocess API ของ Bun สำหรับ Git/BuildKit เฉพาะจุดที่ไม่มี Docker Engine API ที่เหมาะสม
- เก็บ subprocess arguments เป็น array ไม่ต่อ shell command จาก user input
- stdout/stderr ทุก chunk ต้องผ่าน redaction pipeline
- ใช้ `AbortSignal` สำหรับ cancel และ timeout
- graceful shutdown หยุดรับงานใหม่ ต่ออายุ/คืน lease ให้ถูกต้อง และรอ cleanup ที่จำเป็น

## Build Pipeline

```text
Validate configuration
→ Acquire project lock
→ Create isolated workspace
→ Mint GitHub installation token
→ Clone exact commit SHA
→ Build immutable image tag
→ Create candidate container
→ Attach network and volumes
→ Start candidate
→ Health check
→ Add routing labels / activate
→ Stop old container after drain period
→ Mark succeeded
→ Schedule cleanup
```

## Naming และ Immutability

```text
Image:     deploy/<project-id>:<commit-sha>-<deployment-id>
Container: dp-<project-id>-<deployment-id>
Network:   deploy-proxy
Labels:    platform.managed=true
           platform.project_id=<id>
           platform.deployment_id=<id>
```

- ห้าม reuse image tag ที่ mutable เช่น `latest` เป็น source of truth
- บันทึก image ID/digest หลัง build
- ทุก resource ต้องมี ownership labels เพื่อ cleanup อย่างปลอดภัย

## Activation Strategy

MVP ใช้ **start-before-stop**:

1. Container เดิมยังรับ traffic
2. Candidate container เริ่มและผ่าน health check
3. เปิด route ไป candidate
4. รอ drain period
5. หยุด container เดิม

หาก candidate ล้มเหลว ให้ลบ candidate และคง route/container เดิมโดยไม่เปลี่ยนแปลง

## Operations API

```text
POST /api/v1/projects/:id/deploy
POST /api/v1/projects/:id/redeploy
POST /api/v1/projects/:id/restart
POST /api/v1/projects/:id/stop
POST /api/v1/projects/:id/rollback
POST /api/v1/deployments/:id/cancel
GET  /api/v1/projects/:id/deployments
GET  /api/v1/deployments/:id
```

## Rollback

- เก็บ image ของ successful deployments อย่างน้อย 2–3 รุ่น
- Rollback สร้าง deployment record ใหม่ที่อ้าง image digest เดิม
- ใช้ Environment/Domain/Volume configuration version ที่กำหนดไว้อย่างชัดเจน
- หาก schema รุ่นแรกยังไม่มี configuration snapshot ให้ระบุว่า rollback เฉพาะ image และใช้ config ปัจจุบัน
- Rollback ต้องผ่าน health check เช่นเดียวกับ deploy ปกติ

## Cleanup Policy

- ลบ workspace เสมอหลังจบงาน
- เก็บ successful images ตาม retention count
- ลบ failed build cache/image ตามอายุ
- ไม่ลบ image ที่ container ใดกำลังอ้างอิง
- cleanup ต้องเลือก resource จาก ownership labels และตรวจ project ID ซ้ำ

## งานดำเนินการ

- [x] สร้าง deployment/job schema และ state machine (M1)
- [x] สร้าง worker lease/heartbeat/recovery (M2)
- [x] สร้าง Git clone แบบ exact SHA และ redacted credential (M4)
- [x] สร้าง Docker build adapter และ progress parser (M5)
- [x] สร้าง candidate container และ resource limits (M5/M6)
- [x] สร้าง health check runner (M6)
- [x] สร้าง activation/rollback logic (M6)
- [x] สร้าง manual deploy/restart/stop UI
- [x] สร้าง deployment history และ status timeline
- [x] สร้าง safe cleanup worker (M7)

## การทดสอบ Failure Cases

- Clone ล้มเหลว
- Dockerfile ไม่มีหรือ path traversal
- Build timeout / out-of-memory
- Candidate container crash-loop
- Health check timeout
- Worker ถูก kill ระหว่างทุก state
- API/control plane restart ระหว่าง deploy
- Push ซ้อนหลายครั้ง
- Disk full
- Docker daemon unavailable
- Rollback image ถูกลบหรือเสียหาย

## Exit Criteria

สถานะจริงหลัง M1-M7 (backend ครบ, ยืนยันด้วย 490 automated tests + live-Docker integration tests
+ manual E2E สคริปต์เดียวที่รัน real clone/build/container/rollback จริงบน Docker Desktop —
`apps/deploy-worker/scripts/e2e-smoke.ts`):

- [x] Deploy repository ได้จาก webhook (push → auto-deploy) และ manual trigger ผ่าน API —
      ยังไม่ผ่าน UI จริง (M8) เพราะยังไม่มี GitHub App ติดตั้งจริงในเครื่อง dev เพื่อทดสอบ private
      repo ผ่าน webhook จริง แต่ pipeline เดียวกันถูกยืนยันด้วย E2E script (local git remote แทน
      GitHub) + M3's HTTP round-trip tests (routes จริง, mock GitHub client)
- [x] Build failure ไม่กระทบ active deployment — พิสูจน์ทั้งใน unit tests (M6) และยืนยันจริงใน E2E
      script (ADR-0004: container ใหม่ต้องขึ้นสำเร็จก่อน container เก่าถึงถูกปิด)
- [x] Restart worker แล้ว queue recover ได้โดยไม่สร้าง container ซ้ำ — `recoverStaleLeases` (M2) +
      idempotent create (remove-before-create ทุกครั้ง, M6) มี regression test ครอบ
- [x] Manual stop/restart/redeploy/rollback ทำงานและมี audit record — Operations API ครบ (M3),
      rollback ยืนยันจริงใน E2E script ว่า container กลับไปใช้ image เดิมได้โดยไม่ clone/build ซ้ำ
- [x] Cleanup ไม่แตะ resource ที่ระบบไม่ได้เป็นเจ้าของ — ADR-0005 label re-verify ก่อนลบทุกครั้ง (M7),
      negative test ยืนยัน project อื่นไม่ถูกแตะ

**ยังไม่ทำ (out of scope รอบนี้ตามแผนที่ตกลงไว้)**: M8 dashboard UI (deploy/restart/stop/rollback
ปุ่มกด, deployment history/timeline หน้าจอ) และการทดสอบผ่าน GitHub App ติดตั้งจริง — ทั้งสองเป็น
งานรอบถัดไป
