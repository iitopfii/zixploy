# Phase 8 — Security Hardening, Recovery และ Production Release

## เป้าหมาย

เปลี่ยนระบบที่ feature-complete ให้พร้อมดูแลจริง โดยเน้น Docker privilege, untrusted builds, recovery และ operational visibility

## Security Hardening

### Docker Access

- Elysia Control API/Dashboard ไม่ควรเข้าถึง Docker socket
- แยก Bun Deploy Worker เป็น service เฉพาะ แม้ใช้ repository และ types ร่วมกัน
- หากใช้ socket proxy ให้ allowlist เฉพาะ endpoints ที่จำเป็น
- Worker รันด้วย service account และ filesystem permissions ต่ำสุดที่ทำได้
- ห้าม expose Docker TCP API แบบไม่มี mTLS

### Bun/Elysia Runtime

- Pin Bun version และ lockfile ใน release image
- ใช้ production image แบบ multi-stage และไม่รวม source/build tools ที่ไม่จำเป็นใน API image
- ตั้ง memory/CPU limits แยกสำหรับ Elysia API และ Bun worker
- ทดสอบ graceful shutdown ของ HTTP/SSE และ worker lease ก่อนทุก release
- ตรวจ dependency advisories และอัปเดต Bun/Elysia เป็นรอบ โดยผ่าน integration tests ก่อน production

### Untrusted Builds

- ถือว่า Dockerfile และ source code ไม่ปลอดภัย
- จำกัด CPU, memory, PID, build timeout และ workspace size
- ไม่ mount control-plane secrets เข้า build
- แยก build network policy เท่าที่ Docker รุ่นเป้าหมายรองรับ
- ห้าม privileged container, host network, device mounts และ custom capabilities ใน MVP
- ตรวจ image/container configuration ก่อน create

### Web Security

- TLS เท่านั้นสำหรับ Dashboard
- Secure headers, CSRF, session rotation และ login rate limit
- Origin/Host validation
- Dependency/image scanning ใน CI
- Signed release artifacts หรือ pinned image digests สำหรับ control plane
- Audit events สำหรับ login, config changes, deploy, rollback, volume deletion

## Reconciliation

สร้าง periodic reconciler เปรียบเทียบ desired state ใน DB กับ actual state ใน Docker:

- Active container หาย → mark degraded และเสนอ redeploy
- Container orphan ที่มี ownership labels → quarantine/report ก่อน cleanup
- DB บอก deploying แต่ไม่มี worker lease → recover job
- Domain route ไม่พร้อม → recheck และแสดง degraded
- Volume reference ไม่ตรง → block destructive operations
- Installation ถูกถอนสิทธิ์ → disable source actions

## Backup Scope

ต้องสำรอง:

- SQLite consistent snapshot
- Encryption keys (แยกช่องทางจาก DB backup)
- GitHub App private key และ webhook secret
- Traefik ACME storage
- Control-plane configuration
- Named volumes ตามนโยบายราย project

ต้องมี restore drill ลงเครื่องใหม่ ไม่ใช่เพียงมีไฟล์ backup

## Upgrade Strategy

- Database migration แบบ forward-compatible เท่าที่ทำได้
- Backup อัตโนมัติก่อน migration
- Control-plane image ใช้ immutable version tag/digest
- Upgrade ทีละ service พร้อม health check
- มี documented rollback สำหรับ application และ DB migration
- Traefik upgrade แยกจาก platform release

## Operational Checks

- Health/readiness ของ Dashboard, API, worker, DB, Docker และ Traefik
- Disk/inode pressure
- Queue depth และ oldest queued job
- Deploy success rate/duration
- Certificate expiry/error
- Backup age และ last restore drill
- GitHub webhook failure rate
- Worker crash/recovery count

## Production Test Matrix

### Functional

- GitHub install → select private repo → deploy → domain HTTPS
- Push auto deploy
- Environment change + redeploy
- Failed build แล้ว production ไม่ดับ
- Runtime logs และ restart
- Volume persistence และ rollback

### Failure/Recovery

- Restart ทุก control-plane service
- Docker daemon restart
- Server reboot ระหว่าง build/activation
- GitHub API unavailable/rate limited
- DNS/ACME unavailable
- Disk nearly full
- Corrupted/missing image
- Restore DB + keys + ACME storage ลงเครื่องใหม่

### Security

- Forged/replayed webhook
- Unauthorized API/CSRF
- Malicious domain/header input
- Dockerfile พยายามอ่าน platform secrets
- Log injection/secret exfiltration patterns
- Attempt privileged/host mounts
- Volume delete race

## Release Checklist

- [ ] Production configuration ไม่มี development defaults
- [ ] Admin password/bootstrap secret ถูกเปลี่ยน
- [ ] Firewall เปิดเฉพาะ SSH, 80, 443 ตามที่ต้องใช้
- [ ] Dashboard อยู่หลัง HTTPS
- [ ] Docker API ไม่เปิด public
- [ ] Backup schedule และ retention พร้อม
- [ ] Restore drill สำเร็จและบันทึกเวลา RTO/RPO
- [ ] Log rotation และ disk alerts พร้อม
- [ ] ACME production resolver พร้อมและ staging ถูกปิด
- [ ] GitHub webhook delivery ทดสอบผ่าน
- [ ] Resource limits ทุก container พร้อม
- [ ] Runbooks และ incident contacts พร้อม
- [ ] Versioned release และ changelog พร้อม

## Runbooks ที่ต้องมี

- Control plane เข้าไม่ได้
- Deployment ค้าง
- Docker daemon unavailable
- Disk เต็ม
- Certificate ออกไม่ได้
- GitHub App ถูกถอนสิทธิ์
- Restore SQLite และ encryption key
- Restore Traefik certificates
- Restore named volume
- Rotate GitHub private key/webhook secret
- Rotate environment encryption key

## งานดำเนินการ

- [x] M1: Untrusted build resource sandbox — `--resource memory/cpu-quota/cpu-period` + `--ulimit nproc` บน `docker buildx build` (BUILD_SANDBOX_LIMITS, buildkit.ts: buildBuildxArgs), workspace size limit หลัง clone (workspace.ts: assertWorkspaceSizeWithinLimit) — ดู threat-model.md section 3
- [x] M2: General reconciliation loop (`apps/deploy-worker/src/reconciler.ts`) — active container หาย → `projects.degraded_at` (mark degraded, ต้อง redeploy), orphan container (label ครบแต่ไม่มี deployment ใน DB) → report-only log; deploying-without-lease recovery ครอบคลุมแล้วโดย `recoverStaleLeases()` ที่มีอยู่ก่อน (ทุกครั้งที่ jobLoop claim); domain readiness recheck และ installation-revoked handling ยังไม่ทำ (ต้องมี Traefik state adapter / GitHub installation webhook handler แยกต่างหาก)
- [x] M3: Audit log (`apps/control-api/src/audit/log.ts`) — `audit_events` table (migration 0012), fail-open `recordAuditEvent()`, `GET /api/v1/audit-events` (keyset pagination); wired เข้า login/logout (สำเร็จ+ล้มเหลว), project update/archive, deploy/redeploy/restart/stop/rollback/cancel, volume delete
- [ ] M4: Backup automation (encryption keys, GitHub App PEM/webhook secret, ACME storage)
- [ ] M5: Web security (secure headers, CSRF, session rotation, login rate limit, origin/host validation)
- [ ] M6: Production docker-compose, resource limits ทุก container, runbooks, release checklist sign-off

## Exit Criteria

- End-to-end production test matrix ผ่าน
- Restore drill บน clean server สำเร็จ
- Security review ไม่มี critical/high issue ค้าง
- Monitoring/alerts ครอบคลุม failure หลัก
- Operator ที่ไม่ได้เขียนระบบสามารถ deploy, rollback และกู้คืนตาม runbook ได้
