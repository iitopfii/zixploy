# Runbook: Certificate ออกไม่ได้ (Let's Encrypt / ACME)

**อาการ**: HTTPS ใช้งานไม่ได้, Traefik log มี `unable to obtain ACME certificate` / `acme: error: 400`, browser เห็น cert error หรือ `NET::ERR_CERT_AUTHORITY_INVALID`

---

## 1. ดู Traefik log

```bash
docker logs zixploy-traefik --tail 100 | grep -i "acme\|cert\|tls\|error"

# ดู access log สำหรับ ACME challenge path
docker exec zixploy-traefik tail -50 /var/log/traefik/access.log | grep "acme-challenge"
```

---

## 2. DNS ยังไม่ชี้มาที่ server

```bash
# ตรวจ A record
dig +short A <ZIXPLOY_DOMAIN>
# ผลต้องเป็น public IP ของ server

# ตรวจ PTR (optional แต่ช่วย ACME trust)
dig +short -x <SERVER_IP>
```

ถ้า DNS ยังไม่ propagate → รอสูงสุด 24–48 ชั่วโมง, ห้าม request cert ซ้ำระหว่างนั้น (Let's Encrypt rate limit)

---

## 3. Port 80 ถูก block

Traefik ต้องใช้ port 80 สำหรับ TLS challenge HTTP-01:

```bash
# บน host
ss -tlnp | grep ':80'

# ทดสอบจากภายนอก
curl -v http://<ZIXPLOY_DOMAIN>/.well-known/acme-challenge/test
```

ถ้า firewall block → เปิด port 80:
```bash
ufw allow 80/tcp
ufw allow 443/tcp
```

---

## 4. Rate limit ของ Let's Encrypt

Let's Encrypt อนุญาต 5 cert ต่อ domain ต่อสัปดาห์ (production)

```bash
# ตรวจ rate limit จาก log
docker logs zixploy-traefik | grep "429\|rate limit\|too many"
```

ถ้า rate limited → รอ 7 วัน ห้าม delete acme.json แล้ว restart (จะ request ใหม่)

ระหว่างรอ: สามารถใช้ staging ทดสอบได้ (เปลี่ยน `--certificatesresolvers.letsencrypt.acme.caserver` เป็น `https://acme-staging-v02.api.letsencrypt.org/directory`)

---

## 5. acme.json เสียหาย

```bash
# ดู acme.json
docker run --rm -v zixploy-traefik-acme:/acme alpine cat /acme/acme.json | jq . 2>&1 | head -30

# ถ้า parse ไม่ได้ — restore จาก backup
# (ดู backup-restore.md ข้อ "Restore Traefik Certificates")
```

⚠️ อย่า delete acme.json โดยไม่มี backup — Let's Encrypt rate limit ยังคงนับแม้ไฟล์จะหาย

---

## 6. Reset acme.json (กรณีที่มั่นใจว่ายังไม่ถึง rate limit)

```bash
# หยุด Traefik ก่อน
docker compose -f deploy/control-plane/docker-compose.prod.yml stop traefik

# Backup ก่อนเสมอ
docker run --rm -v zixploy-traefik-acme:/acme \
  -v $(pwd):/backup alpine cp /acme/acme.json /backup/acme.json.bak

# Clear
docker run --rm -v zixploy-traefik-acme:/acme alpine sh -c "echo '{}' > /acme/acme.json && chmod 600 /acme/acme.json"

# Start Traefik (จะ request cert ใหม่)
docker compose -f deploy/control-plane/docker-compose.prod.yml start traefik

# Monitor
docker logs zixploy-traefik --follow | grep -i acme
```

---

## 7. Domain ของ project user (custom domain)

สำหรับ domain ที่ user เพิ่มผ่าน Domains tab:

```bash
# ตรวจสถานะ DNS ผ่าน API
curl -sf -H "Cookie: session=<token>" \
  https://<DOMAIN>/api/v1/projects/<PROJECT_ID>/domains/<DOMAIN_ID>/check | jq .
```

User ต้องตั้ง CNAME/A ชี้มาที่ server ก่อน Traefik ถึงจะออก cert ได้ — ตรวจ `dnsStatus` ก่อนเพิ่ม domain

---

## ดูเพิ่มเติม

- [backup-restore.md](./backup-restore.md) — restore acme.json จาก backup
- [control-plane-down.md](./control-plane-down.md) — Traefik ไม่รัน
