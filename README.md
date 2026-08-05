# Zixploy

Lightweight deployment platform สำหรับ single-node Linux server — เชื่อม GitHub App, auto deploy เมื่อ push, จัดการ domains + HTTPS อัตโนมัติ, environment secrets, logs และ Docker volumes

เอกสารแผนงานทั้งหมดอยู่ใน [docs/](docs/README.md)

## โครงสร้าง Repository

```text
apps/
  dashboard/       Nuxt dashboard (UI + auth)
  control-api/     Elysia Control API (Bun)
  deploy-worker/   Bun Deploy Worker — process แยก, ผู้เดียวที่แตะ Docker
internal/
  shared/          Types, state machine, error codes, naming conventions
  db/              SQLite connection + migration runner
  docker/          Docker Engine adapter (phase 3)
  github/          GitHub App integration (phase 2)
  deploy/          Deploy pipeline logic (phase 3)
  proxy/           Traefik label generation (phase 5)
migrations/        SQL migrations
deploy/
  control-plane/   Compose files สำหรับรัน platform เอง
docs/              แผนงานและ decision records
```

## ข้อกำหนดระบบ

- **Development:** Bun >= 1.3, Docker Engine (Windows/macOS/Linux ได้)
- **Production:** Linux x86_64 (Ubuntu 22.04/24.04 LTS หรือ Debian 12), Docker Engine >= 25 พร้อม BuildKit
  — ดูรายละเอียดใน [docs/conventions.md](docs/conventions.md)

## Local Development

```bash
bun install
```

เปิดแต่ละ service คนละ terminal **ตามลำดับนี้** — API เป็นผู้สร้างและ migrate database ส่วน worker จะไม่สตาร์ทถ้ายังไม่มี database:

```bash
bun run dev:api
```

```bash
bun run dev:worker
```

```bash
bun run dev:dashboard
```

เปิด Traefik สำหรับทดสอบ routing (ต้องมี Docker daemon ทำงานอยู่):

```bash
docker compose -f deploy/control-plane/docker-compose.dev.yml up -d
```

| Service | URL |
|---|---|
| Dashboard | http://localhost:3000 |
| Control API | http://127.0.0.1:3001 |
| Traefik dashboard (dev เท่านั้น) | http://127.0.0.1:8080 |

ตรวจสุขภาพระบบ: `GET /api/v1/system/health` — ตอบ `ok` เมื่อ database และ worker พร้อมทั้งคู่ ตอบ `degraded` พร้อมเหตุผลเมื่อ worker ไม่ได้รันหรือ heartbeat ค้าง

หมายเหตุ:

- Nuxt dev server bind IPv6 — ใช้ `localhost:3000` ไม่ใช่ `127.0.0.1:3000`
- Database อยู่ที่ `data/zixploy.sqlite` (override ด้วย `ZIXPLOY_DB_PATH`) — API และ worker ต้องชี้ไฟล์เดียวกัน

## คำสั่งประจำ

```bash
bun run typecheck   # ตรวจ TypeScript ทุก package
bun run lint        # Biome lint + format check
bun test            # Unit/integration tests
bun run migrate:check  # ตรวจ migration จากฐานข้อมูลว่าง (up + rollback)
```

## หลักการสถาปัตยกรรมที่ตรึงไว้

- Control API **ไม่มีสิทธิ์เข้าถึง Docker socket** — worker เท่านั้นที่แตะ Docker Engine
- งาน deploy ทำผ่าน persistent queue ใน SQLite; HTTP handler ไม่รอ build จบ
- ทุก resource ที่ระบบสร้างต้องมี ownership labels (`platform.managed=true`)
- Secret เข้ารหัสก่อนลง DB และผ่าน redaction ก่อนออก log ทุกทาง

ดู decision records ใน [docs/adr/](docs/adr/)
