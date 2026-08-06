# Runbook: Deployment ค้าง

**อาการ**: Deployment อยู่ใน state `cloning`/`building`/`starting`/`health_checking`/`activating` นานผิดปกติ (เกิน `deploy_timeout_sec` ของ project) หรือไม่เปลี่ยนสถานะเลยนานหลายนาที

---

## 1. ตรวจสอบสถานะ

```bash
# ดู deployment ล่าสุด
curl -sf -H "Cookie: session=<token>" \
  https://<DOMAIN>/api/v1/projects/<PROJECT_ID>/deployments?limit=5 | jq '.items[].status'

# ดู deploy worker log
docker logs zixploy-deploy-worker --tail 100 --follow
```

---

## 2. Worker ไม่ claim job (deploy_jobs ค้าง pending)

```bash
# ตรวจว่ามี job ที่ lease หมดอายุไหม
docker exec zixploy-control-api bun run --cwd /app cli:query \
  "SELECT id, status, attempts, lease_expires_at FROM deploy_jobs WHERE status = 'leased' ORDER BY created_at DESC LIMIT 10"
```

`recoverStaleLeases` จะ release lease ที่หมดอายุให้อัตโนมัติทุก poll cycle (ค่า default: 2 วินาที) ถ้า worker ยังรันอยู่ job จะถูก claim ใหม่เองใน `max_attempts` รอบ

ถ้า worker ไม่รัน → restart worker:
```bash
docker compose -f deploy/control-plane/docker-compose.prod.yml restart deploy-worker
```

---

## 3. Build ค้างใน `building` state

สาเหตุที่พบบ่อย: image ขนาดใหญ่มาก, npm install ช้า, network timeout

```bash
# ดู build process ที่รันอยู่
docker exec zixploy-deploy-worker ps aux

# ดู buildx builders
docker buildx ls

# ตรวจ disk space ก่อน (build อาจหยุดเพราะ disk เต็ม)
df -h
```

ถ้า disk เต็ม → ดู [disk-full.md](./disk-full.md)

Deployment จะ fail อัตโนมัติเมื่อเกิน `deploy_timeout_sec` (default: 600 วินาที) ที่ตั้งไว้ใน project config

---

## 4. Health check ค้าง (`health_checking`)

Container อาจขึ้นแต่ไม่ healthy:

```bash
# ดู container ที่กำลัง health check
docker ps --filter "label=platform.project_id=<PROJECT_ID>"

# ดู log ของ container นั้น
docker logs <CONTAINER_ID> --tail 50

# ดู health check status
docker inspect <CONTAINER_ID> --format '{{json .State.Health}}'
```

สาเหตุ:
- **Process crash loop**: `RestartCount` > 0 → ดู log สำหรับ crash reason
- **Port ไม่ตรง**: ตรวจ `health_check_path` + `container_port` ใน project config
- **App start ช้ากว่า timeout**: เพิ่ม `deploy_timeout_sec` ใน project settings

---

## 5. Cancel deployment ที่ค้าง

```bash
curl -sf -X POST \
  -H "Cookie: session=<token>" \
  -H "X-CSRF-Token: <csrf>" \
  https://<DOMAIN>/api/v1/deployments/<DEPLOYMENT_ID>/cancel
```

หรือผ่าน Dashboard → Deploy tab → Cancel

Worker จะ pick up `cancel_requested_at` ใน poll cycle ถัดไปและ abort

---

## 6. Force-reset (กรณีสุดท้าย — worker ตายและ job ค้าง leased)

```bash
# reset job กลับเป็น failed
docker exec zixploy-control-api bun run --cwd /app cli:query \
  "UPDATE deploy_jobs SET status='failed', updated_at=unixepoch('now')*1000 WHERE id='<JOB_ID>'"

# อัปเดต deployment เป็น failed
docker exec zixploy-control-api bun run --cwd /app cli:query \
  "UPDATE deployments SET status='failed', failure_code='DEPLOY_TIMEOUT_EXCEEDED', finished_at=unixepoch('now')*1000, updated_at=unixepoch('now')*1000 WHERE id='<DEPLOYMENT_ID>'"
```

จากนั้น trigger deploy ใหม่ผ่าน Dashboard

---

## ดูเพิ่มเติม

- [control-plane-down.md](./control-plane-down.md) — worker ไม่รัน
- [docker-daemon-unavailable.md](./docker-daemon-unavailable.md) — Docker daemon หยุด
- [disk-full.md](./disk-full.md) — disk เต็มระหว่าง build
