# Runbook: Rotate Encryption Master Key

**อัปเดตล่าสุด**: 2026-08  
**ขอบเขต**: `environment_variables.value_ciphertext` ทุกแถวใน SQLite DB  
**ประมาณเวลา**: 5–15 นาที (ไม่รวมเวลาสร้าง key ใหม่และ backup)

---

## เมื่อไหร่ควร Rotate

- Key ถูก expose หรือสงสัยว่าถูก expose (ดู threat-model.md §M-01)
- ปฏิบัติ rotation ตามกำหนด (แนะนำทุก 90 วันในสภาพแวดล้อม production)
- หลังจากบุคลากรที่มีสิทธิ์เข้าถึง key file ออกจากทีม
- อัปเกรด cipher suite ในอนาคต

---

## ข้อกำหนดเบื้องต้น

1. **มีสิทธิ์เข้าถึง** `ZIXPLOY_MASTER_KEY_FILE` ปัจจุบัน (บน server หรือ KMS)
2. **Backup DB ล่าสุด** — ดูด้านล่าง §ขั้นตอนที่ 2
3. CLI [`bun`](https://bun.sh) ติดตั้งอยู่บน control-api server
4. ไม่มี deploy กำลังรันอยู่ (ตรวจสอบด้วย `GET /projects/:id/deployments`)

---

## ขั้นตอน

### ขั้นที่ 1: สร้าง key ใหม่

```bash
# สร้าง 32-byte key แบบ random (hex)
NEW_KEY=$(openssl rand -hex 32)
echo "new key: $NEW_KEY"  # copy ไว้ — แสดงครั้งเดียว
```

จด key id ถัดไปที่จะใช้ — ถ้า key file ปัจจุบันมี `"active": 1` ให้ใช้ id ถัดไปเป็น `2`, ถ้าเป็น `2` ให้ใช้ `3` และเพิ่มขึ้นเรื่อยๆ (ห้ามนำ id เก่ากลับมาใช้ซ้ำ)

### ขั้นที่ 2: Backup DB

```bash
# ตัวอย่างด้วย sqlite3
sqlite3 /var/lib/zixploy/data.db ".backup /var/lib/zixploy/backups/data-before-rotation-$(date +%Y%m%d%H%M%S).db"

# ยืนยัน backup
sqlite3 /var/lib/zixploy/backups/data-before-rotation-*.db "SELECT count(*) FROM environment_variables;"
```

### ขั้นที่ 3: อัปเดต key file ให้มีทั้ง old keys และ new key

Key file format (docs/encryption.md):

```json
{
  "active": 2,
  "keys": {
    "1": "<hex 32 bytes — old key, ต้องคงไว้สำหรับ decrypt>",
    "2": "<hex 32 bytes — new key ที่เพิ่งสร้าง>"
  }
}
```

> ⚠️ **สำคัญ**: ต้องคง old key ไว้ใน `"keys"` — rotation script จะ **decrypt** ด้วย old key ก่อนแล้วค่อย re-encrypt ด้วย new active key  
> ถ้าลบ old key ออกก่อน → decrypt จะล้มเหลว → แถวนั้นถูก mark เป็น `failed`

```bash
# ตั้ง file permission (owner-read only)
chmod 600 /path/to/keys.json
```

### ขั้นที่ 4: Dry run (ตรวจสอบก่อนจริง)

```bash
ZIXPLOY_MASTER_KEY_FILE=/path/to/keys.json \
  bun run --cwd /app/apps/control-api rotate:encryption --dry-run
```

ผลลัพธ์ที่คาดหวัง:

```
[rotate-encryption] active key id = 2
[rotate-encryption] DB = /var/lib/zixploy/data.db
[rotate-encryption] DRY RUN — ไม่มีการเขียนลง DB
[rotate-encryption] dry-run summary: total=42, needs-rotation=42, already-current=0
```

### ขั้นที่ 5: รัน rotation จริง

```bash
ZIXPLOY_MASTER_KEY_FILE=/path/to/keys.json \
  bun run --cwd /app/apps/control-api rotate:encryption
```

ผลลัพธ์ที่คาดหวัง (ไม่มี error):

```
[rotate-encryption] active key id = 2
[rotate-encryption] DB = /var/lib/zixploy/data.db
[rotate-encryption] พบ 42 แถวใน environment_variables
[rotate-encryption]   batch 1/1: rotated=42, skipped=0, failed=0
[rotate-encryption] เสร็จสิ้น: total=42 rotated=42 skipped=0 failed=0
[rotate-encryption] สำเร็จ: rotated=42 skipped=0 total=42
```

**Exit code 0** = สำเร็จ  
**Exit code 1** = มี `failed > 0` หรือ error ขั้นต้น — ดู §หากมี failed ด้านล่าง

### ขั้นที่ 6: ยืนยันผลลัพธ์

```bash
# Dry run อีกครั้ง — ต้อง needs-rotation=0 ทั้งหมด
ZIXPLOY_MASTER_KEY_FILE=/path/to/keys.json \
  bun run --cwd /app/apps/control-api rotate:encryption --dry-run
# expected: needs-rotation=0, already-current=42
```

### ขั้นที่ 7: Restart control-api และ deploy-worker

หลัง rotation สำเร็จ ทั้งสอง process ใช้ key file เดิมอยู่แล้ว (อ่านตอน start) — ถ้า process กำลังรันอยู่และ **ไม่ได้ reload key file dynamically** ให้ restart:

```bash
# ตัวอย่างด้วย systemd
systemctl restart zixploy-control-api zixploy-deploy-worker

# ตรวจสอบว่า start ได้ปกติ
systemctl status zixploy-control-api zixploy-deploy-worker
```

### ขั้นที่ 8: (ทางเลือก) ลบ old key หลังยืนยันทุกอย่างปกติ

หลังจาก rotation ผ่านไป 1–2 deploy cycle ที่สำเร็จ ค่อยลบ old key ออกจาก file:

```json
{
  "active": 2,
  "keys": {
    "2": "<new key>"
  }
}
```

> อย่าลบ old key ก่อนยืนยันว่า rotation สำเร็จ 100% (needs-rotation=0)

---

## Idempotency

**รัน rotation ซ้ำได้ปลอดภัย** — แถวที่ใช้ active key อยู่แล้วจะถูก `skip` ทันทีโดยไม่ decrypt ซ้ำ  
ไม่ต้องกังวลว่า rotation จะ "เขียนทับ" แถวที่ถูก rotate แล้ว

---

## หากมี `failed > 0`

1. **ตรวจ log** — มีบรรทัด `⚠ ข้าม "<key>" ...` บอก key ชื่ออะไรและ error อะไร
2. **ตรวจว่า old key ยังอยู่ใน key file** — ถ้า `failed` เกิดจาก "no key found for id X" แสดงว่า old key ถูกลบออกแล้ว ให้นำกลับมาใส่
3. **Ciphertext เสียหาย** — ถ้า GCM auth tag ไม่ตรง → แถวนั้น decrypt ไม่ได้จริงๆ ให้ดู backup ก่อน rotation เพื่อ restore ค่านั้น
4. **รัน rotation อีกครั้ง** หลังแก้ไข — แถวอื่นที่ rotate แล้วจะถูก skip โดยอัตโนมัติ

---

## Restore จาก Backup (กรณีฉุกเฉิน)

```bash
# หยุด services ก่อน
systemctl stop zixploy-control-api zixploy-deploy-worker

# แทน DB ด้วย backup
cp /var/lib/zixploy/data.db /var/lib/zixploy/data.db.broken
cp /var/lib/zixploy/backups/data-before-rotation-<timestamp>.db /var/lib/zixploy/data.db

# คืน old key file (ก่อนเพิ่ม new key)
# ... แล้วค่อย restart
systemctl start zixploy-control-api zixploy-deploy-worker
```

---

## ข้อมูลอ้างอิง

- [docs/encryption.md](../encryption.md) — Envelope format และ AAD binding
- [docs/threat-model.md](../threat-model.md) — §M-01 Master key exposure
- [docs/adr/ADR-0003.md](../adr/ADR-0003.md) — Encryption envelope design
- Source: `apps/control-api/src/env/rotation.ts`, `apps/control-api/src/cli/rotate-encryption.ts`
