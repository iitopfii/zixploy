# Runbook: Docker Daemon Unavailable

**อาการ**: Deploy worker log แสดง `DOCKER_UNAVAILABLE` / `connect ENOENT /var/run/docker.sock` / deployment fail ทันทีก่อนถึง `building` state

---

## 1. ตรวจสอบสถานะ Docker daemon

```bash
# บน host machine
docker info

# ถ้า daemon ไม่ตอบ
systemctl status docker
journalctl -u docker --since "10 minutes ago"
```

---

## 2. Docker daemon หยุด — restart

```bash
systemctl restart docker

# รอให้ daemon พร้อม
timeout 30 bash -c 'until docker info &>/dev/null; do sleep 1; done'
echo "Docker ready"
```

จากนั้น restart deploy worker (เพื่อให้ pre-flight ping ผ่านและรับ job ใหม่):
```bash
docker compose -f deploy/control-plane/docker-compose.prod.yml restart deploy-worker
```

---

## 3. Docker socket permission

Worker ต้องเข้าถึง `/var/run/docker.sock` ได้:

```bash
# ตรวจ permission
ls -la /var/run/docker.sock

# ตรวจว่า worker container mount socket ถูก
docker inspect zixploy-deploy-worker --format '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}{{end}}'
```

ถ้า permission ไม่ถูก:
```bash
chmod 660 /var/run/docker.sock
# เพิ่ม user ที่ worker รันเป็นเข้า docker group (ถ้าไม่รันเป็น root)
usermod -aG docker <worker-user>
```

---

## 4. Disk เต็ม ทำให้ daemon ไม่ start

```bash
df -h /var/lib/docker
```

ถ้า disk เต็ม → ดู [disk-full.md](./disk-full.md) ก่อน แล้วค่อย restart docker

---

## 5. Docker daemon หยุดทำงานกะทันหัน (OOM / kernel panic)

```bash
# ดู system log
journalctl -k --since "30 minutes ago" | grep -i "oom\|kill\|panic"

# ดู docker daemon log เพิ่ม
journalctl -u docker --since "30 minutes ago" | tail -50
```

ถ้า OOM killer ฆ่า daemon → เพิ่ม swap หรือเพิ่ม RAM host machine, พิจารณาลด memory limit ของ worker container

---

## 6. ตรวจสอบหลัง recovery

```bash
# daemon ready
docker ps

# worker reconnect
docker logs zixploy-deploy-worker --tail 20

# trigger deploy ใหม่สำหรับ project ที่ค้างอยู่
curl -sf -X POST \
  -H "Cookie: session=<token>" \
  -H "X-CSRF-Token: <csrf>" \
  https://<DOMAIN>/api/v1/projects/<PROJECT_ID>/deploy
```

---

## ดูเพิ่มเติม

- [disk-full.md](./disk-full.md) — disk เต็ม
- [deployment-stuck.md](./deployment-stuck.md) — deployment ค้างหลัง recovery
- [control-plane-down.md](./control-plane-down.md) — control plane down
