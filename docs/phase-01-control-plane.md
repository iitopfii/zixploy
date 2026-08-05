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

- [ ] สร้าง DB connection และ migration runner
- [ ] สร้าง Elysia plugins สำหรับ authentication, request ID, error mapping และ rate limit
- [ ] สร้าง typed API client สำหรับ Nuxt จาก contract เดียวกับ Elysia
- [ ] สร้าง user/session/project schema
- [ ] สร้าง authentication middleware
- [ ] สร้าง project CRUD และ validation
- [ ] สร้าง Dashboard shell และ API client
- [ ] สร้าง global error handling พร้อม request ID
- [ ] เพิ่ม health/readiness endpoints
- [ ] เพิ่ม backup command สำหรับ SQLite แบบ consistent snapshot

## การทดสอบ

- Unit: password hashing, session expiry, validation และ project lifecycle
- Integration: login → create project → restart service → project ยังอยู่
- Security: unauthenticated/CSRF request ถูกปฏิเสธ
- UI: loading, empty, error และ expired-session states
- Recovery: restore DB snapshot ลง instance ใหม่ได้

## Exit Criteria

- Admin ใช้งาน project CRUD ผ่าน Dashboard ได้
- Authentication และ session tests ผ่าน
- Restart ไม่ทำข้อมูลสูญหาย
- ไม่มี secret หรือ credential ปรากฏใน application logs
