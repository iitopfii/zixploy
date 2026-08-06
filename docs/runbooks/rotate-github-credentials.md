# Runbook: Rotate GitHub App Private Key / Webhook Secret

**ใช้เมื่อ**:
- Private key หลุด (log, git, screenshot)
- Webhook secret ถูก expose
- Rotate เป็นนโยบายรักษาความปลอดภัย (แนะนำทุก 90 วัน)
- GitHub แจ้งเตือน compromise

---

## A. Rotate Private Key (RSA/PEM)

Private key ใช้สำหรับ mint installation access token — ถ้า leak แล้วคนอื่น mint token ของ GitHub App ได้

### A1. สร้าง key ใหม่ใน GitHub

1. ไปที่ `https://github.com/settings/apps/<APP_SLUG>`
2. เลื่อนลงไปที่ **Private keys**
3. คลิก **Generate a private key** (GitHub จะ download `.pem` ไฟล์ทันที)
4. **ยังไม่ต้อง delete key เก่า** — รอจนกว่าจะ rotate เสร็จก่อน

### A2. Encrypt + update key ใน DB

```bash
# บน server — อ่าน PEM จาก file
PEM=$(cat /tmp/new-github-app.pem)

# อัปเดตผ่าน Zixploy CLI
docker exec -i zixploy-control-api bun run --cwd /app cli:rotate-github-key \
  --github-app-id <GITHUB_APP_DB_ID> \
  --pem "$PEM"

# ลบ PEM ออกจาก disk ทันที
rm /tmp/new-github-app.pem
```

Script จะ:
1. Encrypt PEM ด้วย master key (AES-256-GCM + envelope)
2. UPDATE `github_apps SET private_key_enc = ?` ใน DB
3. Log ว่า rotate สำเร็จ (PEM ไม่ปรากฏใน log)

### A3. Verify token minting ยังใช้งานได้

```bash
# Trigger manual deploy ที่ connect กับ app นี้
curl -sf -X POST \
  -H "Cookie: session=<token>" \
  -H "X-CSRF-Token: <csrf>" \
  https://<DOMAIN>/api/v1/projects/<PROJECT_ID>/deploy | jq .

# ดู worker log
docker logs zixploy-deploy-worker --tail 30 --follow | grep -i "token\|clone"
```

### A4. Delete key เก่าใน GitHub

หลังยืนยันว่า deploy ผ่าน key ใหม่สำเร็จแล้ว:

1. GitHub → Settings → Apps → Private keys
2. Delete key เก่า (ระบุจาก fingerprint / created date)

---

## B. Rotate Webhook Secret

Webhook secret ใช้สำหรับ verify HMAC-SHA256 signature ของ push event — ถ้า leak แล้ว attacker inject push event ปลอมได้

### B1. สร้าง secret ใหม่

```bash
NEW_SECRET=$(openssl rand -hex 32)
echo $NEW_SECRET  # เก็บไว้ชั่วคราว
```

### B2. อัปเดตใน GitHub ก่อน

1. GitHub → Settings → Apps → `<APP_SLUG>` → Webhook secret
2. ใส่ `NEW_SECRET` ที่สร้างไว้ → Save
3. GitHub จะ sign webhook ด้วย secret ใหม่ทันที (อาจมี delivery ที่ verify ไม่ผ่านช่วงสั้นๆ)

### B3. อัปเดตใน Zixploy DB

```bash
docker exec zixploy-control-api bun run --cwd /app cli:rotate-webhook-secret \
  --github-app-id <GITHUB_APP_DB_ID> \
  --secret "$NEW_SECRET"

# ลบ secret ออกจาก environment ทันที
unset NEW_SECRET
```

### B4. ยืนยัน webhook ทำงาน

1. GitHub → Apps → Advanced → Recent Deliveries
2. Redeliver delivery ล่าสุด
3. ดูว่า status เป็น 200 (ไม่ใช่ 401)

หรือ push commit เล็กๆ และดู worker log:
```bash
docker logs zixploy-deploy-worker --tail 20 --follow
```

---

## Security notes

- Private key ต้อง **ไม่ปรากฏใน git, log, หรือ env var** — เก็บเฉพาะใน DB (encrypted) และ `/tmp` ชั่วคราวเท่านั้น ลบทันทีหลังใช้
- Webhook secret ต้อง **ไม่ถูก log** — control-api ใช้ HMAC เปรียบเทียบ แต่ไม่ log raw value
- ทั้งสองค่าถูก encrypt ด้วย master key ก่อนเก็บใน SQLite — ดู [rotate-encryption-key.md](./rotate-encryption-key.md) ถ้าต้องการ rotate master key ด้วย

---

## ดูเพิ่มเติม

- [github-app-revoked.md](./github-app-revoked.md) — installation ถูก revoke
- [rotate-encryption-key.md](./rotate-encryption-key.md) — rotate master encryption key
