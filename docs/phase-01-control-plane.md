# Phase 1 — Control Plane, Authentication และ Persistence

## เป้าหมาย

สร้างฐานของ Dashboard และ API ที่ปลอดภัย พร้อมเก็บ project configuration และสถานะระบบอย่างถาวร

## User Stories

- Admin login/logout และ session หมดอายุได้
- Admin เห็นรายการ project และสถานะล่าสุด
- Admin สร้าง แก้ไข archive project ได้
- ระบบยังจำ configuration หลัง restart

## Backend Work

### Elysia/Bun Baseline

- Elysia เป็น HTTP framework ของ Control API
- Bun เป็น runtime, package manager และ test runner
- ใช้ schema validation ของ Elysia สำหรับ request, response และ environment configuration
- แยก route modules ตาม domain: auth, projects, GitHub, deployments, domains, logs และ volumes
- แชร์ TypeScript types ระหว่าง API และ Nuxt ผ่าน generated contract หรือ package ภายใน workspace
- งานที่ใช้เวลานานส่งเข้า persistent queue เท่านั้น; route handler ไม่รอ build/deploy จบ
- API process ไม่มีสิทธิ์เข้าถึง Docker socket ส่วน Bun worker เป็นผู้เรียก Docker Engine

### Authentication

- Single admin bootstrap ผ่าน CLI หรือ environment variables ครั้งแรก
- Hash password ด้วย Argon2id
- ใช้ secure, httpOnly, sameSite cookie
- CSRF protection สำหรับ mutation endpoints
- Session expiration และ revoke all sessions
- Rate limit login และบันทึก failed attempts โดยไม่เก็บ password

### API พื้นฐาน

```text
POST   /api/v1/auth/login
POST   /api/v1/auth/logout
GET    /api/v1/auth/session
GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/:id
PATCH  /api/v1/projects/:id
POST   /api/v1/projects/:id/archive
GET    /api/v1/system/health
```

### Persistence

- SQLite WAL mode และ busy timeout
- Foreign keys เปิดใช้งานเสมอ
- Migration ทำก่อน API รับ traffic
- Soft-delete/archive project ที่มี deployment history
- UUID/ULID สำหรับ public IDs; ไม่เปิดเผย row ID
- Transaction สำหรับ mutation ที่แตะหลายตาราง

## Dashboard Work

- Login screen
- App shell, navigation และ system health indicator
- Project list พร้อมสถานะ `running`, `deploying`, `failed`, `stopped`
- Create Project wizard placeholder
- Project overview พร้อมช่องว่างสำหรับ Deploy, Environment, Domains, Logs, Volumes
- Empty/loading/error states
- Confirmation dialog สำหรับ destructive action

## Security Requirements

- API ไม่ bind สู่ public interface โดยตรงหากอยู่หลัง Traefik
- ทุก mutation มี authentication, authorization และ CSRF checks
- Security headers และ Content Security Policy
- Request body size limit
- Structured logs ต้องไม่มี cookie, password หรือ secret
- Backup file และ database permission ต้องจำกัดเฉพาะ service account

## งานดำเนินการ

- [x] สร้าง DB connection และ migration runner — `internal/db`
- [x] สร้าง Elysia plugins สำหรับ authentication, request ID, error mapping และ rate limit — `apps/control-api/src/plugins/`
- [x] สร้าง typed API client สำหรับ Nuxt จาก contract เดียวกับ Elysia — Eden treaty จาก `App` type (`useApi.ts`)
- [x] สร้าง user/session/project schema — migration `0002_auth_and_projects.sql`
- [x] สร้าง authentication middleware — `plugins/auth.ts` (ตรวจ auth ก่อน CSRF เพื่อให้ status code สอดคล้องกัน)
- [x] สร้าง project CRUD และ validation — รวม path traversal guard สำหรับ dockerfile path/build context
- [x] สร้าง Dashboard shell และ API client — login, app shell, project list/detail, settings form
- [x] สร้าง global error handling พร้อม request ID — error envelope เดียวทั้งระบบ
- [x] เพิ่ม health/readiness endpoints — `/api/v1/system/health` แยก DB กับ worker
- [x] เพิ่ม backup command สำหรับ SQLite แบบ consistent snapshot — `bun run backup` (VACUUM INTO + integrity check)

เพิ่มเติมนอกเหนือรายการเดิม:

- [x] Structured logging พร้อม redaction กลาง — `internal/shared/src/logger.ts`
- [x] Architecture guard test ว่า Control API เข้าถึง Docker ไม่ได้ — `architecture.test.ts`

## การทดสอบ

- [x] Unit: password hashing, session expiry, validation และ project lifecycle — `auth-core.test.ts`
- [x] Integration: login → create project → restart service → project ยังอยู่ — `persistence.test.ts` (ปิด connection แล้วเปิด instance ใหม่บนไฟล์เดิม) และตรวจซ้ำด้วยการ restart process จริง
- [x] Security: unauthenticated/CSRF request ถูกปฏิเสธ — `security-contract.test.ts`, `project-routes.test.ts`
- [x] UI: loading, empty, error และ expired-session states — ตรวจผ่าน browser จริง (ดู "หลักฐานการทดสอบ")
- [x] Recovery: restore DB snapshot ลง instance ใหม่ได้ — `persistence.test.ts` (login + อ่าน/เขียนต่อได้หลัง restore)

## หลักฐานการทดสอบ

Automated: **110 tests** ครอบคลุม auth core, auth routes, project CRUD, security contract,
persistence/restore, log redaction และ architecture guard

ตรวจผ่าน browser จริงบน dev stack:

| Flow | ผล |
|---|---|
| เข้าหน้าใด ๆ โดยไม่ login | redirect ไป `/login` |
| password ผิด | แสดงข้อความ ไม่ตั้ง session cookie |
| login → สร้าง project | สำเร็จ, URL ใช้ ULID |
| แก้ไขใน Settings tab | field validation ทำงาน, บันทึกสำเร็จ, แสดง "บันทึกแล้ว", ปุ่ม disable เมื่อไม่มีการแก้ไข |
| archive project | ต้องพิมพ์ชื่อยืนยัน, ปุ่มยืนยัน disabled จนกว่าจะตรง |
| เปิด project ที่ archive แล้ว | input ทั้ง 6 ช่องและปุ่มทั้งหมด disabled, ซ่อนปุ่ม archive |
| restart API + worker แล้ว reload | session และ project ยังอยู่ ไม่ต้อง login ใหม่ |
| API call ไม่มี session / ไม่มี CSRF / body ใหญ่เกิน | 401 / 403 / 400 ตามลำดับ |
| backup → restore ลง instance ใหม่ | login ได้ ข้อมูล project ครบ |

## Exit Criteria

- [x] Admin ใช้งาน project CRUD ผ่าน Dashboard ได้ — สร้าง, ดู, **แก้ไข** และ archive ครบผ่าน UI
- [x] Authentication และ session tests ผ่าน
- [x] Restart ไม่ทำข้อมูลสูญหาย
- [x] ไม่มี secret หรือ credential ปรากฏใน application logs — บังคับด้วย `log-redaction.test.ts` ที่ตรวจ log จริงจาก flow login/ใช้งาน/logout

**สถานะ: Phase 1 ผ่าน Exit Criteria แล้ว**

## สิ่งที่ยังไม่มีหลังจบ Phase 1

Phase 1 ให้เฉพาะ control plane — ความสามารถหลักของแพลตฟอร์มยังไม่ถูกสร้าง:

- ยังไม่มี GitHub App, repository picker หรือ webhook (Phase 2)
  — field `installation_id`, `repo_id`, `branch` ใน `projects` ยังว่างเสมอ
- ยังไม่มี deploy queue, build pipeline หรือ container lifecycle (Phase 3)
  — `auto_deploy` บันทึกค่าได้แต่ยังไม่มีผลใด ๆ
- ยังไม่มี environment variables/secrets (Phase 4)
- ยังไม่มี domains หรือ HTTPS flow สำหรับ production (Phase 5)
  — Traefik มีเฉพาะ dev stack ที่ bind localhost
- ยังไม่มี build/runtime logs (Phase 6) และ volumes (Phase 7)
