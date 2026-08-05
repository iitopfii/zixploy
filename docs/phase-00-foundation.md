# Phase 0 — Foundation และ Architecture Contract

## เป้าหมาย

ตรึงขอบเขตและสัญญาทางสถาปัตยกรรมก่อนเริ่ม implementation เพื่อป้องกันการขยายเป็นแพลตฟอร์ม orchestration เต็มรูปแบบโดยไม่จำเป็น

## ผลลัพธ์ที่ต้องส่งมอบ

- Product requirements ฉบับ MVP
- Architecture diagram และ trust boundaries
- Domain model และ deployment state machine
- API conventions และ error format
- Repository structure
- Local development environment
- Threat model เบื้องต้น
- Decision records สำหรับเรื่องที่เปลี่ยนภายหลังได้ยาก

## Functional Scope

### รวมใน MVP

- Single admin account
- GitHub App installation และ repository picker
- Dockerfile-based deployment
- Auto/manual deploy
- Runtime environment variables
- หนึ่ง service ต่อหนึ่ง project ในรุ่นแรก
- หลาย domain ต่อ project
- HTTPS อัตโนมัติ
- Build/runtime logs
- Docker named volumes
- Restart, stop, redeploy และ rollbackหนึ่ง revision

### ไม่รวมใน MVP

- Docker Compose หลาย service
- Preview deployments ต่อ pull request
- Multi-server และ scheduling
- Horizontal scaling
- Managed databases
- Teams, RBAC และ audit compliance ขั้นสูง
- Shell terminal ผ่าน browser
- Arbitrary host bind mounts
- Custom Traefik configuration จากผู้ใช้

## Architecture Contract

```mermaid
flowchart TB
    Browser[Admin Browser] --> Dashboard[Nuxt Dashboard]
    Dashboard --> API[Control API]
    GitHub[GitHub App Webhooks] --> API
    API --> DB[(SQLite)]
    API[Elysia Control API] --> Queue[Persistent Deploy Queue]
    Worker[Bun Deploy Worker] --> Queue
    Worker --> GitHub
    Worker --> Docker[Docker Engine]
    Traefik[Traefik] --> Docker
    Internet --> Traefik
```

### Trust boundaries

- Internet-facing: Dashboard login, GitHub callback, webhook endpoint และ ports 80/443
- Privileged: worker ที่เข้าถึง Docker Engine
- Secret-bearing: GitHub private key, webhook secret, encryption master key และ project environment secrets
- Untrusted input: repository source code, Dockerfile, build output, domain และ webhook payload

## Core Domain Model

| Entity | หน้าที่ |
|---|---|
| `users` | บัญชี admin และ session policy |
| `github_installations` | installation ID และ account metadata |
| `projects` | repository, branch, build configuration และ desired state |
| `deployments` | commit SHA, status, timestamps, image และ failure reason |
| `deploy_jobs` | durable queue, attempts และ lease |
| `environment_variables` | encrypted value และ build/runtime scope |
| `domains` | hostname, target port, TLS/DNS status |
| `volumes` | Docker volume name, mount path และ lifecycle state |
| `webhook_deliveries` | delivery ID สำหรับ idempotency |

## Deployment State Machine

```text
queued
  -> cloning
  -> building
  -> starting
  -> health_checking
  -> activating
  -> succeeded

ทุก state ก่อน succeeded -> failed หรือ cancelled
```

กติกา:

- การเปลี่ยน state ต้องเป็น transaction และบันทึก timestamp
- งานเดียวทำได้โดย worker เดียวผ่าน lease
- การ retry ต้องไม่สร้าง active container ซ้ำ
- `failed` ต้องมี machine-readable code และข้อความสำหรับผู้ใช้

## Repository Structure ที่แนะนำ

```text
apps/
  dashboard/
  control-api/
internal/
  docker/
  github/
  deploy/
  proxy/
migrations/
deploy/
  control-plane/
docs/
```

## งานดำเนินการ

- [x] เขียน user stories และ non-goals — [requirements.md](./requirements.md)
- [x] ตั้งค่า Bun workspace และ TypeScript shared packages — `internal/shared`, `internal/db`
- [x] สร้าง Elysia Control API พร้อม typed request/response schemas
- [x] สร้าง Bun Deploy Worker เป็น entrypoint และ process แยกจาก API — [ADR-0002](./adr/0002-worker-process-isolation.md)
- [x] กำหนด supported Linux distribution และ Docker version — [conventions.md](./conventions.md)
- [x] กำหนด naming convention ของ image, container, network และ volume — `internal/shared/src/naming.ts` พร้อม unit tests
- [x] กำหนด API prefix `/api/v1` — `internal/shared/src/constants.ts`
- [x] กำหนด error envelope และ request ID — `internal/shared/src/errors.ts`, ทดสอบใน `security-contract.test.ts`
- [x] ออกแบบ database schema และ migration strategy — [database-schema.md](./database-schema.md)
- [x] กำหนด encryption/key rotation approach — [encryption.md](./encryption.md) (ออกแบบแล้ว, implement ใน Phase 4)
- [x] ทำ threat model สำหรับ Docker socket, webhook, build และ secrets — [threat-model.md](./threat-model.md)
- [x] ทำ local stack ที่เปิด Dashboard, API, SQLite และ Traefik ได้ — `bun run dev` + `bun run dev:proxy`
- [x] เพิ่ม lint, typecheck, unit test และ migration check ใน CI — `.github/workflows/ci.yml`

## การทดสอบ

- [x] เปิด local stack จากเครื่องใหม่ได้ตาม README — ตรวจด้วย `bun run dev` (API + worker + dashboard พร้อมกัน)
- [x] Migration จากฐานข้อมูลว่างทำงานและ rollback ใน development ได้ — `bun run migrate:check` (up → down → up)
- [x] API health endpoint ตรวจ DB และ worker readiness แยกกัน — `app.test.ts`
- [x] State machine ปฏิเสธ transition ที่ไม่ถูกต้อง — `deployment-state.test.ts`

## Exit Criteria

- [x] ไม่มีคำถามค้างเรื่อง scope ที่กระทบ schema หลัก — scope ตรึงใน [requirements.md](./requirements.md)
- [x] Architecture และ security boundaries ได้รับการ review — ADR-0001 ถึง ADR-0005 และมีเทสต์บังคับว่า Control API แตะ Docker ไม่ได้ (`architecture.test.ts`)
- [x] Local development stack ทำงานซ้ำได้
- [x] CI baseline ผ่านทั้งหมด — lint, typecheck (รวม Dashboard), migration check, tests, dashboard build

**สถานะ: Phase 0 ผ่าน Exit Criteria แล้ว**

หมายเหตุ: state machine, naming helper และ encryption design ถูกสร้างเป็น "สัญญา" ไว้ล่วงหน้า
แต่ยังไม่มีผู้ใช้งานจริงจนกว่าจะถึง Phase 3–4
