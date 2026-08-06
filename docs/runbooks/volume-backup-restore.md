# Runbook: Volume Backup & Restore

Phase 7 — docs/phase-07-volumes.md

> ⚠️ **หมายเหตุสำคัญ**: การ rollback application image ไม่ rollback ข้อมูลใน volume  
> ข้อมูลใน volume เป็นอิสระจาก container lifecycle — backup/restore ต้องทำแยกต่างหากเสมอ

---

## 1. ข้อมูลเบื้องต้น

Docker named volumes ของ zixploy จะถูกตั้งชื่อในรูปแบบ:

```
zxvol-<projectId>-<volumeId>
```

ชื่อนี้สร้างโดย `volumeName()` ใน `@zixploy/shared/naming.ts` — ห้ามตั้งชื่อเอง

ตรวจรายการ volumes ทั้งหมดของ project ได้จาก API:

```bash
curl -b cookies.txt http://localhost:3001/api/v1/projects/<projectId>/volumes
```

หรือจาก Docker โดยตรง:

```bash
docker volume ls --filter label=platform.managed=true
```

---

## 2. Pre-backup checklist

- [ ] ยืนยัน `lifecycle = 'active'` หรือ `'detached'` (ไม่ใช่ `error` หรือ `deletion_pending`)
- [ ] ตรวจว่า Docker volume มีอยู่จริง: `docker volume inspect <docker_name>`
- [ ] หยุด application ชั่วคราวถ้า volume มี single-writer access mode (กัน data corruption ระหว่าง backup)
- [ ] ตรวจ disk space บน host: `df -h /var/lib/docker`

---

## 3. Backup (tar stream ผ่าน helper container)

```bash
# ตัวแปร
VOLUME_NAME="zxvol-<projectId>-<volumeId>"
BACKUP_FILE="volume-backup-$(date +%Y%m%d-%H%M%S).tar.gz"

# สร้าง backup โดย helper container (ไม่ต้อง stop application สำหรับ shared-safe)
docker run --rm \
  -v "${VOLUME_NAME}:/data:ro" \
  -v "$(pwd):/backup" \
  alpine:3 \
  tar czf "/backup/${BACKUP_FILE}" -C /data .

echo "Backup saved: ${BACKUP_FILE}"
ls -lh "${BACKUP_FILE}"
```

### ตรวจสอบ backup

```bash
# ตรวจ integrity
tar tzf "${BACKUP_FILE}" | head -20

# ตรวจ checksum
sha256sum "${BACKUP_FILE}" > "${BACKUP_FILE}.sha256"
cat "${BACKUP_FILE}.sha256"
```

---

## 4. Restore ไปยัง volume ใหม่ (ห้าม overwrite active volume โดยตรง)

```bash
# ขั้นตอน: สร้าง volume ใหม่ → restore → สลับ via API (detach เก่า, attach ใหม่)

# 1. สร้าง volume ใหม่ชั่วคราวสำหรับ restore
RESTORE_VOLUME="zxvol-restore-$(date +%Y%m%d%H%M%S)"
docker volume create "${RESTORE_VOLUME}"

# 2. Restore ข้อมูลลง volume ใหม่
docker run --rm \
  -v "${RESTORE_VOLUME}:/data" \
  -v "$(pwd):/backup:ro" \
  alpine:3 \
  sh -c "tar xzf /backup/${BACKUP_FILE} -C /data && echo 'Restore complete'"

# 3. ตรวจสอบข้อมูลใน volume ใหม่
docker run --rm \
  -v "${RESTORE_VOLUME}:/data:ro" \
  alpine:3 \
  ls -la /data
```

### สลับ volume ผ่าน API

```bash
# สมมติมี volume ใหม่ที่ restore แล้ว — ต้อง re-register ผ่าน API เพื่อให้ระบบรู้จัก
# (ปัจจุบัน MVP ไม่มี "import existing volume" endpoint — สร้าง volume ผ่าน API แล้ว sync ข้อมูล)

# แนวทาง:
# 1. POST /projects/:id/volumes สร้าง volume record ใหม่ (ระบบสร้าง docker_name ให้)
# 2. PATCH /projects/:id/volumes/:oldId/detach  (detach volume เก่า)
# 3. Copy ข้อมูลจาก restore volume ไปยัง volume ใหม่ที่ระบบสร้าง
# 4. Deploy ใหม่เพื่อ mount volume ใหม่
```

---

## 5. Restore ฉุกเฉิน (volume เก่ายังมีอยู่)

กรณีที่ต้องการ overwrite ข้อมูลใน volume เดิม (ยอมรับ downtime):

```bash
# 1. Stop application (ผ่าน API)
curl -X POST -b cookies.txt \
  -H "x-csrf-token: <token>" \
  http://localhost:3001/api/v1/projects/<projectId>/stop

# 2. Restore ข้อมูล
VOLUME_NAME="zxvol-<projectId>-<volumeId>"
docker run --rm \
  -v "${VOLUME_NAME}:/data" \
  -v "$(pwd):/backup:ro" \
  alpine:3 \
  sh -c "rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/${BACKUP_FILE} -C /data"

# 3. Redeploy
curl -X POST -b cookies.txt \
  -H "x-csrf-token: <token>" \
  http://localhost:3001/api/v1/projects/<projectId>/deploy
```

---

## 6. ตรวจสอบ Volume state หลัง restore

```bash
# ตรวจ lifecycle ผ่าน inspect endpoint
curl -X POST -b cookies.txt \
  http://localhost:3001/api/v1/projects/<projectId>/volumes/<volumeId>/inspect

# คาดหวัง: { "volume": { "lifecycle": "active", ... } }
```

---

## 7. Volume orphan (lifecycle='error')

Volume ที่มี `lifecycle = 'error'` หมายถึง Docker volume หายไป (ถูกลบมือ, host พัง ฯลฯ)

```bash
# ตรวจ
docker volume inspect zxvol-<projectId>-<volumeId>

# ถ้า Docker volume หายไปจริง:
# 1. Restore จาก backup ตามขั้นตอนข้างต้น
# 2. หรือ detach volume record (lifecycle จะอยู่ที่ error จนกว่า admin จะ action)
curl -X POST -b cookies.txt \
  -H "x-csrf-token: <token>" \
  http://localhost:3001/api/v1/projects/<projectId>/volumes/<volumeId>/detach

# 3. จากนั้น delete record
curl -X DELETE -b cookies.txt \
  -H "x-csrf-token: <token>" \
  http://localhost:3001/api/v1/projects/<projectId>/volumes/<volumeId>
```

---

## 8. Extension points (อนาคต)

MVP ออกแบบให้รองรับ backup automation ในอนาคต:

- `pre_backup_command` — เรียกก่อน tar (เช่น `pg_dump`, `mysqldump`)
- Backup metadata: `{ volumeId, checksum, sizeBytes, timestamp, driver }`
- Scheduled backup ผ่าน `deploy_jobs` queue (type = 'volume_backup')
- S3/GCS upload ผ่าน backup agent container
- Restore validation: ตรวจ checksum ก่อน mark restore สำเร็จ

---

## ดูเพิ่มเติม

- [docs/phase-07-volumes.md](../phase-07-volumes.md)
- [docs/threat-model.md](../threat-model.md)
- [apps/deploy-worker/src/volumes/reconciler.ts](../../apps/deploy-worker/src/volumes/reconciler.ts)
