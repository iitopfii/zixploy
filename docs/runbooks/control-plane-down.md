# Runbook: Control Plane เข้าไม่ได้

**อาการ**: Dashboard/API ไม่ตอบสนอง หรือ error 502/503/timeout

---

## 1. ระบุสาเหตุ

```bash
# ตรวจสถานะ containers ทั้งหมด
docker compose -f deploy/control-plane/docker-compose.prod.yml ps

# ดู log ล่าสุดของแต่ละ service
docker logs zixploy-control-api --tail 50
docker logs zixploy-deploy-worker --tail 50
docker logs zixploy-dashboard --tail 50
docker logs zixploy-traefik --tail 50
```

---

## 2. Traefik ไม่รันหรือ cert ไม่ valid

```bash
# ตรวจ Traefik
docker inspect zixploy-traefik --format '{{.State.Status}}'

# ดู access log
docker exec zixploy-traefik tail -20 /var/log/traefik/access.log

# ถ้า Traefik ไม่รัน — restart
docker compose -f deploy/control-plane/docker-compose.prod.yml restart traefik
```

ถ้า cert error → ดู [certificate-failed.md](./certificate-failed.md)

---

## 3. Control API crash / restart loop

```bash
docker logs zixploy-control-api --tail 100 2>&1 | grep -i "error\|fatal\|panic"

# ตรวจ exit code
docker inspect zixploy-control-api --format '{{.State.ExitCode}}'
```

สาเหตุที่พบบ่อย:
- **DB ไม่พร้อม / schema ไม่ตรง**: ดูข้อ 4
- **Master key ไม่พบ**: ดูข้อ 5
- **Port ถูก bind แล้ว**: `ss -tlnp | grep 3001`

---

## 4. SQLite database เสีย / migration ไม่ตรง

```bash
# ตรวจ integrity
docker exec zixploy-control-api bun run --cwd /app migrate:check

# ถ้า DB เสีย — restore จาก backup (ดู backup-restore.md ข้อ 4)
```

---

## 5. Master key ไม่พบหรืออ่านไม่ได้

```bash
# ตรวจว่า key file มีอยู่และอ่านได้จาก container
docker exec zixploy-control-api test -r /run/secrets/master_key && echo OK || echo MISSING

# ตรวจ permission บน host
ls -la /etc/zixploy/master.key
```

ถ้าหายไป → restore จาก backup (ดู [backup-restore.md](./backup-restore.md) ข้อ 3)

---

## 6. Deploy worker ไม่ claim job แต่ API ปกติ

Worker อาจ crash หลัง claim job → lease หมด → job กลับเป็น `pending` อัตโนมัติ (`recoverStaleLeases`)

```bash
docker logs zixploy-deploy-worker --tail 100

# Restart worker (jobs ที่ค้างจะ recover เอง)
docker compose -f deploy/control-plane/docker-compose.prod.yml restart deploy-worker
```

---

## 7. Restart ทุก service (กรณีสุดท้าย)

```bash
docker compose -f deploy/control-plane/docker-compose.prod.yml down
docker compose -f deploy/control-plane/docker-compose.prod.yml --env-file deploy/control-plane/.env up -d
```

ตรวจ health หลัง restart:

```bash
watch -n 5 'docker compose -f deploy/control-plane/docker-compose.prod.yml ps'
curl -sf https://<ZIXPLOY_DOMAIN>/api/v1/system/health | jq .
```

---

## ดูเพิ่มเติม

- [backup-restore.md](./backup-restore.md) — restore DB + keys
- [certificate-failed.md](./certificate-failed.md) — TLS cert ออกไม่ได้
- [docker-daemon-unavailable.md](./docker-daemon-unavailable.md) — Docker daemon หยุด
