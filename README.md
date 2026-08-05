# Zixploy

Lightweight deployment platform สำหรับ single-node Linux server — เชื่อม GitHub App, auto deploy เมื่อ push, จัดการ domains + HTTPS อัตโนมัติ, environment secrets, logs และ Docker volumes

เอกสารแผนงานทั้งหมดอยู่ใน [docs/](docs/README.md)

## สถานะปัจจุบัน

ระบบอยู่ที่ **Phase 1 เสร็จ** — ใช้งานได้จริงเฉพาะ authentication และ project configuration
ความสามารถหลักของแพลตฟอร์ม **ยังไม่ถูกสร้าง**:

| ความสามารถ | สถานะ |
|---|---|
| Login, session, project CRUD | ✅ ใช้งานได้ |
| GitHub App / repository picker | ❌ ยังไม่มี (Phase 2) |
| Deploy queue และ build pipeline | ❌ ยังไม่มี (Phase 3) |
| Environment variables / secrets | ❌ ยังไม่มี (Phase 4) |
| Domains และ HTTPS flow | ❌ ยังไม่มี (Phase 5) — Traefik มีแค่ dev stack |
| Build/runtime logs | ❌ ยังไม่มี (Phase 6) |
| Volumes | ❌ ยังไม่มี (Phase 7) |

Tab ใน dashboard ของเฟสที่ยังไม่ทำจะแสดง placeholder ที่ระบุเฟสไว้ชัดเจน

## โครงสร้าง Repository

```text
apps/
  dashboard/       Nuxt dashboard (UI + auth)
  control-api/     Elysia Control API (Bun)
  deploy-worker/   Bun Deploy Worker — process แยก, ผู้เดียวที่จะแตะ Docker (Phase 3)
internal/
  shared/          Types, state machine, error codes, naming, logger
  db/              SQLite connection, migration runner, backup
migrations/        SQL migrations
scripts/           Dev tooling (dev.ts รวม stack)
deploy/
  control-plane/   Compose files สำหรับรัน platform เอง
docs/              แผนงานและ decision records
```

`internal/docker`, `internal/github`, `internal/deploy` และ `internal/proxy` จะถูกสร้างเมื่อถึงเฟสที่ใช้จริง (Phase 2–5)

## ข้อกำหนดระบบ

- **Development:** Bun >= 1.3, Docker Engine (Windows/macOS/Linux ได้)
- **Production:** Linux x86_64 (Ubuntu 22.04/24.04 LTS หรือ Debian 12), Docker Engine >= 25 พร้อม BuildKit
  — ดูรายละเอียดใน [docs/conventions.md](docs/conventions.md)

## Local Development

```bash
bun install
```

สร้าง admin คนแรก (ครั้งเดียว — password ต้องยาวอย่างน้อย 12 ตัวอักษร):

```bash
ZIXPLOY_ADMIN_USERNAME=admin ZIXPLOY_ADMIN_PASSWORD='your-long-password' bun run bootstrap:admin
```

เปิด Dashboard + Control API + Worker พร้อมกันด้วยคำสั่งเดียว (Ctrl+C หยุดทั้งหมด):

```bash
bun run dev
```

เปิดแยกทีละ service ก็ได้ — `bun run dev:api`, `bun run dev:worker`, `bun run dev:dashboard`

Traefik แยกต่างหากเพราะต้องใช้ Docker daemon และยังไม่จำเป็นจนถึง Phase 5:

```bash
bun run dev:proxy
```

| Service | URL |
|---|---|
| Dashboard | http://localhost:3000 |
| Control API | http://127.0.0.1:3001 |
| Traefik dashboard (dev เท่านั้น) | http://127.0.0.1:8080 |

ทั้ง API และ Traefik bind เฉพาะ `127.0.0.1` — ไม่มี service ใดเปิดสู่ network ภายนอกใน dev

ตรวจสุขภาพระบบ: `GET /api/v1/system/health` — ตอบ `ok` เมื่อ database และ worker พร้อมทั้งคู่ ตอบ `degraded` พร้อมเหตุผลเมื่อ worker ไม่ได้รันหรือ heartbeat ค้าง

หมายเหตุ:

- Nuxt dev server bind IPv6 — ใช้ `localhost:3000` ไม่ใช่ `127.0.0.1:3000`
- Database อยู่ที่ `data/zixploy.sqlite` (override ด้วย `ZIXPLOY_DB_PATH`) — API และ worker ต้องชี้ไฟล์เดียวกัน
- API เป็นผู้สร้างและ migrate database; worker จะรอไฟล์ database สูงสุด 30 วินาทีแล้วจึงเริ่มทำงาน
- ปรับระดับ log ด้วย `ZIXPLOY_LOG_LEVEL` (`debug` / `info` / `warn` / `error`) — ทุกระดับผ่าน redaction เสมอ

## คำสั่งประจำ

```bash
bun run lint           # Biome lint + format check
bun run typecheck      # TypeScript ทุก workspace รวม Dashboard (nuxt typecheck)
bun test               # Unit/integration tests
bun run migrate:check  # ตรวจ migration จากฐานข้อมูลว่าง (up + rollback + up)
bun run backup         # consistent snapshot ของ database (VACUUM INTO)
bun run dev:proxy:down # หยุด Traefik
```

CI รันชุดเดียวกันนี้ทั้งหมด บวก production build ของ Dashboard

เปลี่ยน password admin (revoke ทุก session เดิมด้วย):

```bash
ZIXPLOY_ADMIN_USERNAME=admin ZIXPLOY_ADMIN_PASSWORD='new-long-password' bun run bootstrap:admin --reset
```

## หลักการสถาปัตยกรรมที่ตรึงไว้

- Control API **ไม่มีสิทธิ์เข้าถึง Docker socket** — worker เท่านั้นที่จะแตะ Docker Engine
  (บังคับด้วยเทสต์ใน `apps/control-api/test/architecture.test.ts`)
- งาน deploy ทำผ่าน persistent queue ใน SQLite; HTTP handler ไม่รอ build จบ (Phase 3)
- ทุก resource ที่ระบบสร้างต้องมี ownership labels (`platform.managed=true`) (Phase 3)
- Secret เข้ารหัสก่อนลง DB (Phase 4) และผ่าน redaction ก่อนออก log ทุกทาง (ใช้งานแล้ว)

ดู decision records ใน [docs/adr/](docs/adr/)
