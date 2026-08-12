# Changelog

ทุก notable change ถูกบันทึกไว้ในไฟล์นี้ ตาม [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format  
Versioning: [Semantic Versioning](https://semver.org/)

---

## [Unreleased]

### Fixed
- Secure flag ของ session/CSRF cookie ตัดสินจาก scheme ของ `ZIXPLOY_BASE_URL` แทน `NODE_ENV` —
  เดิมสมมติว่า "production = HTTPS เสมอ" ซึ่งไม่จริงกับการติดตั้งที่เข้าผ่าน IP ตรง ๆ (`http://<ip>`)
  ทำให้ตั้ง `NODE_ENV=production` ไม่ได้เลยโดยไม่ล็อกตัวเองออกจากระบบ (browser ทิ้ง Secure cookie
  ที่ส่งมาทาง HTTP)

### Security
- ตั้ง `NODE_ENV=production` ให้ control-api ใน `deploy/server/docker-compose.yml` — origin-guard
  จะตัด `localhost`/`127.0.0.1` ออกจาก allowlist ตามที่ออกแบบไว้ (ก่อนหน้านี้ไม่เคยตั้งที่ไหนเลย
  การป้องกัน Host header injection จึงไม่มีผลจริงบน production)

---

## [0.1.2] — 2026-08-13

### Fixed
- Deploy จาก source แบบวาง Dockerfile ล้มเหลวทันที (0 วินาที) ด้วย "commitSha must be a hex SHA" —
  ตัวตรวจรูปแบบใน `imageName()` จำกัด commit SHA ที่ 40 ตัวอักษร (git SHA-1) แต่ source แบบนี้ใช้
  sha256 ของเนื้อหา (64 ตัว) เป็น commitSha สังเคราะห์ ขยาย validator เป็น 7–64 hex และเพิ่ม
  regression test ทั้งฝั่ง shared และ worker pipeline (เทสต์เดิมบังเอิญใช้ค่า 40 ตัวพอดีเลยไม่จับ)

---

## [0.1.1] — 2026-08-12

### Added
- **Exposed port ราย project** — เปิด host port ให้เข้าถึง container ตรง ๆ (เช่น host `3100` →
  container `3000`) ตั้งได้ที่ project → ตั้งค่า ตรวจ conflict กับ project อื่น/managed
  service/port ของระบบให้อัตโนมัติ
  - deploy ของ project ที่เปิด exposed port มี downtime สั้น ๆ ระหว่างสลับ container
    (host port ผูกได้ container เดียว จึงทำ start-before-stop ไม่ได้) — ถ้า deploy ใหม่
    ล้มเหลว ระบบ start container เก่าคืนให้อัตโนมัติ
- **Dashboard Domain** — หน้าตั้งค่าระบบใหม่ ตั้ง domain ที่ใช้เข้า dashboard ได้จาก UI
  มีผลทันทีไม่ต้อง restart (แก้ปัญหา `INVALID_HOST` โดยไม่ต้อง SSH ไปแก้ `.env`)
  พร้อมแสดง IP ของเครื่อง (A record) ให้คัดลอกไปตั้งค่า DNS
- Source แบบวาง Dockerfile ตรง ๆ แทนการเชื่อม GitHub repository (dashboard → Source tab)
- นำเข้า build config จาก docker-compose.yml (dashboard → Settings)
- ตัวติดตั้ง (`install.sh`) เปลี่ยน HTTP/HTTPS port ได้ผ่าน `ZIXPLOY_HTTP_PORT`/`ZIXPLOY_HTTPS_PORT`
- ตัวติดตั้งรองรับ `ZIXPLOY_DOMAIN` — ติดตั้งพร้อมใช้ domain ตั้งแต่แรกโดยไม่เจอ `INVALID_HOST`

### Fixed
- ตัวติดตั้งตั้ง `NODE_ENV=production` ให้ control-api — ก่อนหน้านี้ session/CSRF cookie
  ไม่มี `Secure` flag และ origin-guard อนุโลม `Host: localhost` ตลอดแม้รันจริง
- คำสั่งติดตั้งแบบตั้ง environment variable ใน README — รูปแบบเดิม (`VAR=x curl | sudo -E sh`)
  ตัวแปรไม่ถึงสคริปต์จริง เปลี่ยนเป็น `curl | sudo VAR=x sh`
- URL repository ใหม่หลังย้ายเป็น `github.com/iitopfii/zixploy`

---

## [0.1.0] — 2026-08-07

### Phase 8: Production Hardening

#### Added — M6: Production Docker Compose + Runbooks
- `deploy/control-plane/docker-compose.prod.yml` — production compose ครบ 4 services พร้อม resource limits, healthchecks, ACME TLS production
- `deploy/control-plane/.env.production.example` — template สำหรับ production environment variables
- `docs/runbooks/control-plane-down.md` — วินิจฉัยและแก้ไขเมื่อ Dashboard/API ไม่ตอบสนอง
- `docs/runbooks/deployment-stuck.md` — แก้ไข deployment ที่ค้างใน in-flight state
- `docs/runbooks/docker-daemon-unavailable.md` — recovery เมื่อ Docker daemon หยุด
- `docs/runbooks/disk-full.md` — ล้าง disk + ป้องกัน disk full ใน production
- `docs/runbooks/certificate-failed.md` — debug Let's Encrypt ACME failures
- `docs/runbooks/github-app-revoked.md` — กู้คืนเมื่อ GitHub App installation ถูกถอน
- `docs/runbooks/rotate-github-credentials.md` — rotate GitHub App private key + webhook secret อย่างปลอดภัย
- `docs/runbooks/release-checklist.md` — checklist ก่อน deploy ทุกครั้ง (CI, backup, smoke test, rollback plan)

#### Added — M5: Web Security Hardening
- HSTS header (`Strict-Transport-Security`) พร้อม preload
- Session token rotation หลัง login สำเร็จ (session fixation protection)
- Origin + Host validation middleware
- Security hardening integration tests

#### Added — M4: Backup Automation
- Automated backup: SQLite DB, master key envelope, ACME storage
- Backup retention policy (configurable, default 14 files)
- Backup CLI: `bun run cli:backup`
- Restore runbook: `docs/runbooks/backup-restore.md`

#### Added — M3: Audit Log
- Structured audit log สำหรับ login, project config changes, deploy/rollback triggers, volume deletion
- Audit events เก็บใน `audit_logs` table (migration 0010)

#### Added — M2: Reconciliation Loop
- General reconciliation loop สำหรับ degraded projects และ orphan container report
- Worker ตรวจสอบสุขภาพ container ที่รันอยู่ตาม schedule

#### Added — M1: Untrusted Build Sandbox
- Resource limits สำหรับ untrusted build: memory, cpu, nproc cgroup limits
- Workspace size assertion ก่อนเริ่ม build
- Build sandbox tests

---

### Phase 7: Volume Management

#### Added
- `volumes` table + migration 0009 พร้อม lifecycle state machine (`active → detached → deletion_pending → deleted | error`)
- Volume CRUD API: create, list, detach, delete (typed confirmation)
- Worker: attach/detach named volume จาก container ระหว่าง deploy
- Dashboard: Volumes tab พร้อม lifecycle badges, delete confirmation dialog (typed)
- `docs/runbooks/volume-backup-restore.md` — backup + restore named volume data

---

### Phase 6: Runtime Logs + Domain Management

#### Added
- Runtime log streaming: SSE `/api/v1/projects/:id/runtime-logs/stream`
- Build log: paginated GET + SSE stream สำหรับ in-flight deployment
- Domain CRUD API: add/remove/enable/disable custom domain
- DNS check service: verify A/CNAME record ชี้ถูกต้องก่อนออก cert
- Traefik label generator: generate จาก DB เท่านั้น (ไม่รับ raw label จาก user)
- Dashboard: Logs tab (build + runtime, SSE, auto-scroll), Domains tab (add/check/toggle/delete)

---

### Phase 5: Environment Variables

#### Added
- `env_vars` table + migration 0008: encryption envelope (AES-256-GCM) ต่อ variable
- Environment CRUD API: full-replace PUT, import .env, metadata-only GET (ไม่คืน plaintext)
- Worker: inject env vars เป็น BuildKit secrets (`--secret`) และ runtime env
- Key rotation CLI + runbook: `docs/runbooks/rotate-encryption-key.md`
- Dashboard: Environment tab พร้อม import, scope selector, secret masking

---

### Phase 4: Deploy Engine

#### Added (Phase 4 — deploy pipeline core)
- `deploy_jobs` + `deployments` tables + migration 0006 พร้อม state machine, partial indexes
- Deploy worker queue: claim/lease/renew/recover (lease recovery อัตโนมัติ)
- Build pipeline: `queued → cloning → building → starting → health_checking → activating → succeeded`
- Start-before-stop activation (ADR-0004): candidate ผ่าน health check ก่อนค่อย stop เก่า
- Cancel mechanism: `cancel_requested_at` ไม่ race กับ lease
- Cleanup worker: image retention (3 latest per project), workspace cleanup ใน `finally`
- Deploy timeout: `AbortController` ครอบทั้ง pipeline
- Crash-loop detection: `RestartCount` polling ระหว่าง health check
- Dashboard: Deploy tab พร้อม deployment list, status badges, cancel/rollback actions

---

### Phase 3: GitHub App Integration

#### Added
- GitHub App manifest flow: สร้าง App → callback → store (private key encrypted)
- Installation webhook: verify HMAC-SHA256 signature ก่อนประมวลผล
- Push webhook: enqueue deploy job อัตโนมัติเมื่อ push ถึง deploy branch
- Installation token minting: JWT → installation access token (worker มีสำเนา crypto code ของตัวเอง — ADR-0002)
- Git clone: `http.extraheader` authorization (token ไม่ปรากฏใน clone URL)
- `redactString()` สำหรับ stdout/stderr ก่อน log ใน clone/build step

---

### Phase 2: Auth + Project Management

#### Added
- SQLite migration runner + schema: users, sessions, projects, login_attempts (migrations 0001-0002)
- Auth: bcrypt password hash, session token (128-bit random), CSRF double-submit cookie
- Rate limiting: login 5 attempts / 15 min per IP
- Session expiry: configurable via `SESSION_TTL_HOURS`
- Project CRUD: create, list, get, update, archive
- Admin bootstrap CLI: `bun run cli:bootstrap-admin`
- Dashboard: login screen, app shell, project list, project overview, project settings

---

### Phase 1: Foundation

#### Added
- Bun monorepo workspace (`apps/control-api`, `apps/deploy-worker`, `apps/dashboard`, `internal/shared`, `internal/db`)
- TypeScript base config
- Elysia HTTP framework (control-api)
- Nuxt 3 (dashboard)
- Eden treaty typed API client
- SQLite via `bun:sqlite` (zero native dependency)
- Local dev stack: Traefik + docker compose dev
- CI: lint, typecheck, test, migrate:check
- Architecture enforcement test: `apps/control-api/test/architecture.test.ts`
- ADR-0001 through ADR-0005: key architectural decisions documented

---

[Unreleased]: https://github.com/iiTOPii/zixploy.com/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/iiTOPii/zixploy.com/releases/tag/v0.1.0
