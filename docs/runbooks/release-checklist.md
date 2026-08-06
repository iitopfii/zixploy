# Release Checklist — Zixploy

ใช้ checklist นี้ก่อน **ทุก** production release และ initial deployment

---

## 0. Pre-release verification (CI + local)

- [ ] `bun run typecheck` ผ่านทุก workspace (apps + internal)
- [ ] `bun run lint` ผ่านโดยไม่มี error (warning ได้)
- [ ] `bun test` ผ่านทุก test suite (**ห้าม skip**)
- [ ] `bun run migrate:check` ผ่าน (migration checksums ตรง)
- [ ] `bun run test:architecture` ผ่าน (control-api ไม่ import Docker, worker ไม่ import control-api)
- [ ] CI pipeline ผ่านบน branch ก่อน merge
- [ ] PR ผ่าน review และ merge แล้ว (main branch)

---

## 1. Build และ tag images

```bash
VERSION=$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD)
echo "Building version: $VERSION"

docker buildx build -t zixploy/control-api:$VERSION -t zixploy/control-api:latest \
  --platform linux/amd64 ./apps/control-api

docker buildx build -t zixploy/deploy-worker:$VERSION -t zixploy/deploy-worker:latest \
  --platform linux/amd64 ./apps/deploy-worker

docker buildx build -t zixploy/dashboard:$VERSION -t zixploy/dashboard:latest \
  --platform linux/amd64 ./apps/dashboard
```

- [ ] Images build สำเร็จทั้ง 3 services
- [ ] Image digest บันทึกไว้สำหรับ rollback

---

## 2. Pre-deployment backup (production)

**ทำก่อน deploy เสมอ — ใช้เวลา < 1 นาที**

```bash
# บน production server
docker exec zixploy-control-api bun run --cwd /app cli:backup
```

- [ ] Backup สำเร็จ (ดู log ว่า `backup complete`)
- [ ] Backup file มีอยู่ใน `zixploy-backups` volume

---

## 3. Migration check

```bash
# ตรวจว่า migration ใหม่ใช้ได้กับ DB ที่มีอยู่
docker exec zixploy-control-api bun run --cwd /app migrate:check
```

- [ ] Migration ไม่มี destructive change โดยไม่ได้วางแผน
- [ ] ถ้ามี column drop/rename: มี rollback plan และ backup ก่อนแล้ว

---

## 4. Environment variables

- [ ] `.env` บน server มีทุก required variable (`ZIXPLOY_DOMAIN`, `ACME_EMAIL`, `ZIXPLOY_VERSION`, `MASTER_KEY_PATH`)
- [ ] `ZIXPLOY_VERSION` อัปเดตเป็น version ใหม่
- [ ] Master key file มีอยู่และ permission ถูกต้อง: `chmod 600 /etc/zixploy/master.key`
- [ ] ไม่มี secret ใน `.env` โดยตรง (ใช้ path สำหรับ master key เท่านั้น)

---

## 5. Deploy

```bash
cd /opt/zixploy  # หรือ directory ที่เก็บ docker-compose.prod.yml

# Pull images ใหม่
docker compose -f deploy/control-plane/docker-compose.prod.yml \
  --env-file deploy/control-plane/.env pull

# Deploy (rolling restart — Traefik เก็บ connection เดิม)
docker compose -f deploy/control-plane/docker-compose.prod.yml \
  --env-file deploy/control-plane/.env up -d
```

- [ ] `docker compose ps` แสดง 4 services: `Up (healthy)`
- [ ] ไม่มี container อยู่ใน `restarting` state

---

## 6. Post-deployment verification

```bash
# API health
curl -sf https://<ZIXPLOY_DOMAIN>/api/v1/system/health | jq .

# Dashboard โหลดได้
curl -sf https://<ZIXPLOY_DOMAIN>/ | grep -o "<title>[^<]*</title>"

# TLS ถูกต้อง
curl -sv https://<ZIXPLOY_DOMAIN>/ 2>&1 | grep "SSL certificate verify ok"
```

- [ ] `/api/v1/system/health` ตอบ `{ "status": "ok" }`
- [ ] Dashboard โหลดได้และ login ได้
- [ ] TLS cert valid (Let's Encrypt, ไม่ใช่ self-signed)
- [ ] HTTP → HTTPS redirect ทำงาน: `curl -I http://<DOMAIN>/` ต้องได้ `301`

---

## 7. Smoke test

- [ ] Login ด้วย admin account สำเร็จ
- [ ] สร้าง test project และเห็นใน dashboard
- [ ] Trigger manual deploy สำหรับ project ที่มีอยู่ → deployment เดินผ่าน states จนถึง `succeeded`
- [ ] Logs tab แสดง build log ถูกต้อง
- [ ] Domains tab แสดง domain ที่มีอยู่

---

## 8. Rollback plan (ถ้ามีปัญหา)

```bash
# กลับไป version ก่อนหน้า
PREV_VERSION=<previous-version>
docker compose -f deploy/control-plane/docker-compose.prod.yml \
  --env-file deploy/control-plane/.env down

# แก้ ZIXPLOY_VERSION ใน .env เป็น $PREV_VERSION แล้ว
docker compose -f deploy/control-plane/docker-compose.prod.yml \
  --env-file deploy/control-plane/.env up -d
```

ถ้า schema เปลี่ยน → ดู [backup-restore.md](./backup-restore.md) restore DB ก่อน

---

## 9. Post-release

- [ ] Tag git version: `git tag -a v<VERSION> -m "Release v<VERSION>"`
- [ ] Update CHANGELOG.md ถ้ายังไม่ได้ทำ
- [ ] Notify team ว่า release สำเร็จ
- [ ] Monitor error rate ใน log 30 นาทีหลัง deploy

```bash
# Watch error rate
docker logs zixploy-control-api --follow | grep -i '"level":"error"'
```

---

## Security checklist (ทำทุก release)

- [ ] ไม่มี secret ใน git history (scan ด้วย `git log -p | grep -i "secret\|password\|key" | head -20`)
- [ ] `docs/threat-model.md` ยังตรงกับ implementation (ถ้ามีการเปลี่ยน threat surface)
- [ ] Build secrets ใช้ `--secret` ไม่ใช่ `--build-arg` (ตรวจ Dockerfile ของ project ที่ test)
- [ ] Token ไม่ปรากฏใน clone URL (ดู git log ของ workspace container)
