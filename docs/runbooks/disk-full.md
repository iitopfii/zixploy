# Runbook: Disk เต็ม

**อาการ**: Build fail ด้วย `ENOSPC` / `no space left on device`, Docker daemon ไม่ start, หรือ SQLite write error

---

## 1. ตรวจสอบ disk usage

```bash
# ภาพรวม
df -h

# หาว่า volume ไหนเต็ม
df -h /var/lib/docker
df -h /var/lib/zixploy   # zixploy-data volume
```

---

## 2. Docker image + layer ไม่ใช้แล้ว (สาเหตุที่พบบ่อยที่สุด)

```bash
# ดูว่า Docker ใช้ disk เท่าไหร่
docker system df

# ลบ image, container, network, build cache ที่ไม่ใช้
docker system prune -f

# ลบ build cache ด้วย (ปลอดภัย — rebuild ช้าลงแต่ไม่มีผลต่อ runtime)
docker builder prune -f

# ลบ image ที่ไม่มี container ใช้ (มากกว่า prune ปกติ)
docker image prune -a -f
```

⚠️ อย่าใช้ `docker system prune -a` เมื่อมี container รันอยู่ — ใช้ `prune -f` แทน

---

## 3. Workspace ที่ build ทิ้งค้างไว้

Worker ควรลบ workspace ใน `finally` block แต่ถ้า crash ก่อน:

```bash
# ดู workspace volume
docker run --rm -v zixploy-workspaces:/ws alpine sh -c "du -sh /ws/*"

# ลบ workspace เก่า (เก็บไว้แค่ 24 ชั่วโมงล่าสุด)
docker run --rm -v zixploy-workspaces:/ws alpine sh -c \
  "find /ws -maxdepth 1 -type d -mtime +1 -exec rm -rf {} +"
```

---

## 4. Backup ที่สะสมมากเกินไป

```bash
# ดู backup volume
docker run --rm -v zixploy-backups:/bak alpine du -sh /bak/*

# ถ้า retention script ไม่ทำงาน — ลบ backup เก่าด้วยมือ (เก็บแค่ 14 ล่าสุด)
docker run --rm -v zixploy-backups:/bak alpine sh -c \
  "ls -t /bak/db/*.db.gz | tail -n +15 | xargs rm -f"
```

---

## 5. Log rotation

Log ของ container ถูก limit ผ่าน `logging.options` ใน docker-compose.prod.yml แล้ว  
แต่ถ้า Traefik access log โต:

```bash
# ดู log size
docker run --rm -v zixploy-traefik-logs:/logs alpine du -sh /logs/*

# rotate access log (Traefik จะสร้างใหม่อัตโนมัติ)
docker exec zixploy-traefik kill -USR1 1
```

---

## 6. Expand disk

ถ้าทำตาม 2-5 แล้วยังไม่พอ ต้องเพิ่ม disk บน host:

```bash
# บน cloud VM ขยาย disk แล้วรัน
growpart /dev/sda 1
resize2fs /dev/sda1       # ext4
# หรือ
xfs_growfs /               # xfs
```

---

## 7. ตรวจสอบหลัง recovery

```bash
df -h
docker info  # daemon ยังรันอยู่

# restart worker เพื่อ retry job ที่ fail
docker compose -f deploy/control-plane/docker-compose.prod.yml restart deploy-worker
```

---

## ป้องกัน

- ตั้ง `ZIXPLOY_BACKUP_RETENTION=14` (default) — ลบ backup เก่าอัตโนมัติ
- Worker ตั้ง workspace limit ไว้แล้วผ่าน `assertWorkspaceSize` (2GB ต่อ build)
- พิจารณาใช้ external NFS/S3 mount สำหรับ `zixploy-backups` volume (ดูหมายเหตุใน docker-compose.prod.yml)
- Monitor disk ด้วย `df -h` ใน cron หรือ alerting

---

## ดูเพิ่มเติม

- [docker-daemon-unavailable.md](./docker-daemon-unavailable.md) — daemon ไม่ start หลัง disk เต็ม
- [deployment-stuck.md](./deployment-stuck.md) — deployment fail ด้วย ENOSPC
