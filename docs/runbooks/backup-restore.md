# Runbook: Control Plane Backup & Restore

Phase 8 M4 — docs/phase-08-production.md "Backup Scope" / "Backup automation"

> ดู [docs/runbooks/volume-backup-restore.md](./volume-backup-restore.md) สำหรับ named volume ราย project (คนละเรื่องกัน)

---

## 1. อะไรบ้างที่ต้อง backup

| ส่วน | เก็บที่ไหนตอนรัน | Backup อย่างไร |
|---|---|---|
| SQLite database (projects, deployments, environment ciphertext, GitHub App ciphertext, audit log ฯลฯ) | `ZIXPLOY_DB_PATH` (default `data/zixploy.sqlite`) | `VACUUM INTO` consistent snapshot |
| Master encryption key | `ZIXPLOY_MASTER_KEY_FILE` | copy ไฟล์ไปยัง directory แยกจาก DB |
| Traefik ACME storage (`acme.json`) | `ZIXPLOY_ACME_FILE` | copy ไฟล์ |
| GitHub App private key/webhook secret | **ไม่ต้องแยก** — เก็บเป็น ciphertext ใน DB (`github_apps` table) | ครอบคลุมด้วย DB backup |
| Named volumes ต่อ project | Docker volume `zxvol-<projectId>-<volumeId>` | ดู runbook แยกต่างหาก |

**เหตุผลที่ master key ต้องแยกช่องทางจาก DB backup**: ถ้า backup รวมกันไว้ที่เดียว
คนที่เข้าถึง backup ได้ = decrypt GitHub App credentials/environment variables ได้ทันที
ทำให้การเข้ารหัสไม่มีความหมาย — เก็บ backup DB กับ backup key ไว้คนละที่จริง ๆ (คนละ disk/cloud bucket/access control)

---

## 2. รัน backup

```bash
bun run backup
```

สคริปต์ (`internal/db/scripts/backup.ts`) ทำ 3 อย่างแยกกัน:

1. SQLite snapshot → `ZIXPLOY_BACKUP_DB_DIR` (default `backups/db/`) — ตรวจ `PRAGMA integrity_check` ก่อนถือว่าสำเร็จ
2. Master key (ถ้าตั้ง `ZIXPLOY_MASTER_KEY_FILE`) → `ZIXPLOY_BACKUP_KEYS_DIR` (default `backups/keys/`)
3. ACME storage (ถ้าตั้ง `ZIXPLOY_ACME_FILE`) → `ZIXPLOY_BACKUP_ACME_DIR` (default `backups/acme/`)

แต่ละส่วนเก็บไฟล์ล่าสุด `ZIXPLOY_BACKUP_RETENTION` ชุด (default 14) แล้วลบที่เก่ากว่าทิ้งอัตโนมัติ
ส่วนที่ไม่ได้ตั้ง env (เช่นยังไม่มี ACME เพราะ production compose ยังไม่ deploy) จะข้ามแบบ warning
ไม่ทำให้ script ล้มเหลว — ส่วนที่ "ตั้งค่าไว้แล้วแต่ backup fail" เท่านั้นที่ทำให้ exit code != 0

**สำคัญ**: ค่า default เขียนลง `backups/` ใต้ project directory เพื่อความสะดวกตอน dev เท่านั้น —
production ต้องตั้ง `ZIXPLOY_BACKUP_*_DIR` ชี้ไปยัง mount/disk/off-host storage จริง ไม่ใช่ปล่อย default

### Schedule อัตโนมัติด้วย cron

```cron
# backup ทุกวันตี 3
0 3 * * * cd /opt/zixploy && bun run backup >> /var/log/zixploy-backup.log 2>&1
```

หรือ systemd timer (`zixploy-backup.timer` + `zixploy-backup.service` ที่เรียก `bun run backup`)

---

## 3. Restore SQLite database ลงเครื่องใหม่

```bash
# 1. หยุด control-api และ deploy-worker ก่อนเสมอ (ห้าม restore ทับ DB ที่กำลังใช้งาน)

# 2. คัดลอก backup ล่าสุดไปเป็น DB path จริง
mkdir -p "$(dirname "$ZIXPLOY_DB_PATH")"
cp backups/db/zixploy-<timestamp>.sqlite "$ZIXPLOY_DB_PATH"

# 3. ตรวจ integrity ก่อน start service
sqlite3 "$ZIXPLOY_DB_PATH" "PRAGMA integrity_check;"
# คาดหวัง: ok

# 4. ตรวจ schema version ตรงกับโค้ดที่รัน
bun run migrate:check

# 5. Start control-api — ถ้ามี migration ค้างจะรันอัตโนมัติตอน start (ดู apps/control-api/src/index.ts)
```

---

## 4. Restore master key

```bash
# 1. คัดลอก backup ล่าสุดไปตำแหน่งที่ ZIXPLOY_MASTER_KEY_FILE ชี้
cp backups/keys/master-key-<timestamp>.key /etc/zixploy/master.key
chmod 600 /etc/zixploy/master.key

# 2. ตรวจว่า active key id ใน key file ตรงกับ key_id ที่ ciphertext ใน DB ใช้อยู่จริง
#    (ถ้า restore DB กับ key คนละช่วงเวลากัน อาจ mismatch — ถ้า mismatch environment
#     variables และ GitHub App credentials จะ decrypt ไม่ได้)

# 3. Start control-api — โหลด key file ตอน startup, ผิด format = fail closed (ไม่เปิด service)
```

> ⚠️ **ต้อง restore DB backup กับ master key backup ที่ทำ "พร้อมกัน" หรือใกล้เวลากันที่สุด**
> ถ้า key rotate ไปแล้วหลัง DB backup แต่ก่อน key backup (หรือกลับกัน) ciphertext บางแถวจะ
> decrypt ไม่ได้ — ดู `docs/runbooks/rotate-encryption-key.md` ถ้าต้อง recover จากสถานการณ์นี้

---

## 5. Restore Traefik ACME storage

```bash
# 1. หยุด Traefik container
docker stop zixploy-traefik

# 2. คัดลอก backup ไปตำแหน่งที่ mount เป็น ACME storage
cp backups/acme/acme-<timestamp>.json /path/to/traefik/acme.json
chmod 600 /path/to/traefik/acme.json

# 3. Start Traefik — ใช้ certificate เดิมถ้ายังไม่หมดอายุ ไม่ต้อง re-issue
docker start zixploy-traefik
```

ถ้าไม่มี ACME backup (เครื่องใหม่ + ยังไม่เคย backup) — Traefik จะ re-issue certificate ใหม่ให้ทุก
domain โดยอัตโนมัติเมื่อ container/app กลับมา online (มี downtime สั้น ๆ ระหว่างรอ ACME challenge)

---

## 6. Restore drill (ต้องทำจริง ไม่ใช่แค่มีไฟล์ backup)

- [ ] เตรียมเครื่องใหม่ (หรือ VM แยก) ไม่มี data เดิม
- [ ] ติดตั้ง dependencies (Bun, Docker, Traefik) ตาม README
- [ ] Restore DB (ข้อ 3) + master key (ข้อ 4) + ACME storage (ข้อ 5)
- [ ] Start ทุก service — ตรวจ health endpoint ผ่าน
- [ ] Login เข้า Dashboard ได้ด้วย credential เดิม
- [ ] เปิด project ที่มี environment variables — ตรวจว่า decrypt ได้ปกติ (ไม่ error)
- [ ] เปิด GitHub Apps tab — ตรวจว่า app ที่เคยสร้างยังอยู่และ webhook ยังทำงาน
- [ ] Deploy project ทดสอบสำเร็จ
- [ ] บันทึกเวลาที่ใช้ทั้งหมด (RTO) และข้อมูลที่ยอมรับว่าหายได้สูงสุด (RPO ตาม backup schedule)

---

## ดูเพิ่มเติม

- [docs/phase-08-production.md](../phase-08-production.md)
- [docs/encryption.md](../encryption.md)
- [docs/runbooks/rotate-encryption-key.md](./rotate-encryption-key.md)
- [docs/runbooks/volume-backup-restore.md](./volume-backup-restore.md)
- [internal/db/scripts/backup.ts](../../internal/db/scripts/backup.ts)
