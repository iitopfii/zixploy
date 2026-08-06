# Runbook: GitHub App ถูกถอนสิทธิ์ / Installation Revoked

**อาการ**: Clone fail ด้วย `401 Unauthorized` / `CLONE_FAILED`, webhook ไม่ได้รับ events, หรือ control-api log มี `installation token` error

---

## 1. ระบุสาเหตุ

```bash
# ดู worker log สำหรับ GitHub token error
docker logs zixploy-deploy-worker --tail 100 | grep -i "github\|token\|401\|403\|clone"

# ดู control-api log สำหรับ webhook error
docker logs zixploy-control-api --tail 100 | grep -i "webhook\|github\|signature"
```

สาเหตุที่พบบ่อย:
- **Installation ถูก revoke**: user/org ถอนการติดตั้ง GitHub App
- **Private key หมดอายุหรือถูก rotate**: JWT ไม่ valid → token mint ล้มเหลว
- **App ถูก suspend**: GitHub suspend app เนื่องจาก violation
- **Webhook secret ไม่ตรง**: HMAC verify ล้มเหลว

---

## 2. ตรวจสอบสถานะ GitHub App

ไปที่: `https://github.com/settings/apps/<APP_SLUG>` (หรือ org settings)

ตรวจ:
- App ยังมีอยู่และไม่ถูก suspend
- Installation ยังเชื่อมกับ repo ที่เกี่ยวข้อง
- Private key ยังใช้งานได้ (ดู "Private keys" tab)

---

## 3. Installation ถูก revoke — ให้ user re-install

ถ้า user ที่ project ระบุถอน installation:

1. User ไปที่ GitHub → Settings → Applications → Installed GitHub Apps
2. ค้นหา Zixploy → Install/Reinstall
3. เลือก repo ที่ต้องการ

หรือให้ user ไปที่ Dashboard → Project Settings → GitHub → Reconnect

---

## 4. ตรวจสอบ installation ID ใน DB

```bash
docker exec zixploy-control-api bun run --cwd /app cli:query \
  "SELECT p.name, ga.installation_id, ga.status FROM projects p JOIN github_connections gc ON gc.project_id = p.id JOIN github_apps ga ON ga.id = gc.github_app_id WHERE p.id = '<PROJECT_ID>'"
```

ถ้า `status = 'suspended'` หรือ `installation_id` ไม่มีค่า → GitHub App ถูก suspend หรือ installation หาย

---

## 5. Webhook signature ไม่ตรง

```bash
# ดู webhook delivery จาก GitHub
# GitHub → Settings → Developer settings → GitHub Apps → <App> → Advanced → Recent Deliveries
# หา error 401/403 และดู payload/signature

# ตรวจว่า webhook secret ใน DB ตรงกับ GitHub
docker exec zixploy-control-api bun run --cwd /app cli:query \
  "SELECT id, app_id, name FROM github_apps LIMIT 10"
```

ถ้าต้องการ rotate webhook secret → ดู [rotate-github-credentials.md](./rotate-github-credentials.md)

---

## 6. Verify การกู้คืน

หลังแก้ไขแล้ว ทดสอบด้วย manual deploy:

```bash
curl -sf -X POST \
  -H "Cookie: session=<token>" \
  -H "X-CSRF-Token: <csrf>" \
  https://<DOMAIN>/api/v1/projects/<PROJECT_ID>/deploy | jq .
```

ดู worker log ว่า clone สำเร็จ:
```bash
docker logs zixploy-deploy-worker --tail 30 --follow
```

---

## 7. GitHub App ถูก delete ถาวร — สร้างใหม่

1. ไปที่ Dashboard → Account Settings → GitHub Apps → Create new
2. ทำตาม manifest flow ที่ UI แนะนำ
3. Reconnect แต่ละ project ไปยัง App ใหม่

---

## ดูเพิ่มเติม

- [rotate-github-credentials.md](./rotate-github-credentials.md) — rotate private key / webhook secret
- [control-plane-down.md](./control-plane-down.md) — control-api down
