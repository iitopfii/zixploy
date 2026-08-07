# Phase 5 — Domains, Routing และ Automatic HTTPS

## เป้าหมาย

ให้ Admin เพิ่มหลาย domain ต่อ project เลือก internal port และเปิด HTTPS ได้ โดย Traefik อัปเดต routing ผ่าน Docker labels

## Domain Model

- Hostname (canonical lowercase/punycode)
- Project ID และ target internal port
- HTTPS enabled
- Redirect HTTP → HTTPS
- Redirect mode: none, www-to-root, root-to-www
- DNS status และ last checked time
- Certificate/routing status
- Verification/error message

## Validation

- รับ hostname เท่านั้น ไม่รับ scheme, path หรือ query
- ปฏิเสธ wildcard ใน MVP
- ปฏิเสธ IP address และ reserved/local hostname
- Unique hostname ทั้งระบบ
- Port อยู่ในช่วงที่อนุญาตและตรงกับ container configuration
- Normalize IDN อย่างปลอดภัยและแสดงทั้ง canonical/display form หากจำเป็น

## DNS Check

- Resolve A และ AAAA records
- เปรียบเทียบกับ configured public IPs ของ server
- แสดง `pending`, `valid`, `mismatch`, `proxied`, `unknown`
- DNS mismatch ไม่จำเป็นต้องห้าม save แต่ต้องเตือนก่อนเปิด HTTPS
- ใช้ timeout/cache เพื่อไม่ให้ DNS resolver ทำ API ช้า

### Cloudflare proxy (M5)

เมื่อผู้ใช้เปิด Cloudflare proxy (เมฆส้ม) DNS จะ resolve เป็น Cloudflare edge IP เสมอ
ไม่มีทางชี้มาที่ origin IP ได้เลย — การรายงานว่า `mismatch` จึงผิดและทำให้ผู้ใช้ไปปิด
proxy ทิ้งโดยไม่จำเป็น

- ทุก IP ที่ resolve ได้อยู่ใน Cloudflare range → `proxied` (ปกติ ไม่ใช่ error)
- Cloudflare ปนกับ IP อื่นที่ไม่รู้จัก → `mismatch` (มักเป็น record ค้างที่ตั้งผิด)
- origin IP ตรงแม้จะมี Cloudflare ปน → `valid` (ชนะทุกกรณี)
- CIDR ranges อยู่ใน `internal/shared/src/cloudflare.ts` — ต้องตรงกับ Traefik
  `forwardedHeaders.trustedIPs` ใน `deploy/server/docker-compose.yml` เสมอ
  (ไม่ประกาศ trustedIPs = rate limit/audit log เห็นแต่ IP ของ Cloudflare ไม่ใช่ client จริง;
  ใช้ `insecure=true` แทน = ใครก็ spoof X-Forwarded-For ได้)

## Traefik Integration

สร้าง labels จากข้อมูลภายในเท่านั้น ห้ามรับ raw label จากผู้ใช้:

```text
traefik.enable=true
traefik.http.routers.<router>.rule=Host(`<domain>`)
traefik.http.routers.<router>.entrypoints=websecure
traefik.http.routers.<router>.tls=true
traefik.http.routers.<router>.tls.certresolver=letsencrypt
traefik.http.services.<service>.loadbalancer.server.port=<port>
```

- `exposedByDefault=false`
- Traefik และ app อยู่ใน dedicated proxy network
- Persist ACME storage และตั้ง permission เหมาะสม
- ใช้ staging ACME ใน test environment (`ACME_CA_SERVER`)
- backup certificate storage แต่ไม่แชร์ file storage ระหว่างหลาย Traefik instances

## Certificate Management (M5)

แต่ละ domain เลือก `tls_mode` ได้ 2 แบบ:

| | `letsencrypt` (default) | `custom` |
|--|--|--|
| ที่มา cert | Traefik ขอผ่าน ACME HTTP-01 | ผู้ใช้อัปโหลด PEM |
| ต่ออายุ | อัตโนมัติ | ต้องอัปโหลดใบใหม่เอง |
| wildcard / EV / Cloudflare Origin CA | ไม่ได้ | ได้ |
| Traefik label | `tls.certresolver=letsencrypt` | `tls=true` เท่านั้น |

**สำคัญ**: `tls_mode='custom'` ต้อง **ไม่** ใส่ `certresolver` ใน label — ไม่งั้น Traefik
จะพยายามขอ ACME cert ทับใบที่อัปโหลดไว้

### Storage และ materialization

- cert + key เข้ารหัส AES-256-GCM ก่อน persist เสมอ
  AAD: `domain_tls:<domain_id>:cert` / `domain_tls:<domain_id>:key`
  (ผูกกับทั้ง domain **และ** field — สลับช่อง cert↔key แล้ว decrypt ไม่ได้)
- DB เป็น source of truth; ไฟล์บน volume เป็น projection ให้ Traefik อ่าน
- `syncCertificates()` เป็น **full sync** ทุกครั้ง เรียกหลัง: upload/delete cert,
  enable/disable domain, ลบ domain, และตอน control-api บูต
- private key เขียนด้วย mode `0600`; config เขียนแบบ atomic (tmp → rename)
- ชื่อไฟล์มาจาก domain id (ULID) ไม่ใช่ hostname ที่ผู้ใช้ป้อน

### Validation ก่อนรับ

ปฏิเสธพร้อม error code ที่แยกได้ (`TLS_CERT_KEY_MISMATCH`, `TLS_CERT_HOSTNAME_MISMATCH`,
`TLS_CERT_EXPIRED`, `TLS_KEY_INVALID`, `TLS_CERT_INVALID`):

- cert/key ไม่ใช่ PEM ที่ parse ได้
- key ไม่ใช่คู่ของ cert (`checkPrivateKey`)
- key มี passphrase (Traefik อ่านไม่ได้)
- cert หมดอายุ / ยังไม่ถึงวันเริ่มใช้
- cert ไม่ครอบ hostname ของ domain (รองรับ wildcard 1 ระดับตาม RFC 6125)

### API ห้ามคืน PEM

ไม่มี endpoint ใดคืน plaintext cert หรือ key — คืนแค่ metadata (fingerprint, subject,
issuer, hostnames, expiry) เปลี่ยน = อัปโหลดทับ, เลิกใช้ = DELETE

## Routing Activation

- Domain change สร้าง configuration revision
- วิธีง่ายใน MVP: recreate active container ด้วย labels ใหม่ผ่าน controlled redeploy
- หากเพิ่ม dynamic configuration service ภายหลัง ต้องมี atomic write/validation
- ลบ domain แล้วต้องรอ Traefik route หายก่อนรายงานสำเร็จ
- ตรวจ route ด้วย HTTP probe จาก control plane

## API Surface

```text
GET    /api/v1/projects/:id/domains
POST   /api/v1/projects/:id/domains
PATCH  /api/v1/projects/:id/domains/:domainId
DELETE /api/v1/projects/:id/domains/:domainId
POST   /api/v1/projects/:id/domains/:domainId/check

# custom TLS certificate (M5)
GET    /api/v1/projects/:id/domains/:domainId/certificate   # metadata เท่านั้น
PUT    /api/v1/projects/:id/domains/:domainId/certificate   # upload/replace
DELETE /api/v1/projects/:id/domains/:domainId/certificate   # กลับไปใช้ Let's Encrypt
```

## Dashboard

- Domain list พร้อม DNS, routing และ certificate status
- Add/edit domain form
- แสดง DNS record ที่ผู้ใช้ต้องสร้าง
- Copy server IP
- Retry validation
- Warning ก่อนเปลี่ยน canonical redirect
- ลิงก์เปิดเว็บไซต์เมื่อ route พร้อม

## งานดำเนินการ

- [x] สร้าง domain schema/validation/normalization
- [x] สร้าง DNS resolver/check service
- [x] สร้าง deterministic Traefik label generator
- [x] ผูก labels กับ candidate container
- [x] ตั้ง Traefik HTTP→HTTPS และ ACME resolver
- [x] สร้าง route/certificate probes
- [x] สร้าง domain UI และ status polling
- [x] เพิ่ม duplicate-domain locking ใน DB
- [x] M5: custom TLS certificate (upload/validate/encrypt/materialize)
- [x] M5: Cloudflare proxy support (DNS `proxied` status + Traefik trustedIPs)

## การทดสอบ

- Domain ถูกต้อง/ผิดรูปแบบ/ซ้ำ/IDN
- DNS ยังไม่ชี้, A ถูกแต่ AAAA ผิด และ propagation ช้า
- Certificate issuance ผ่าน staging ACME
- Traefik restart แล้วยังใช้ certificate และ route เดิมได้
- Domain change ระหว่าง active deploy ไม่สร้าง split-brain
- App มีหลาย domain และ redirect ทำงานตามตั้งค่า
- ACME failure แสดง actionable error โดย app เดิมยังให้บริการได้

## Exit Criteria

- เพิ่ม domain แล้ว route ไปยัง project ถูกต้อง
- HTTPS issuance/renewal setup ผ่าน staging และ production smoke test
- Certificate storage อยู่รอดหลัง restart
- ไม่มี raw proxy configuration injection จากผู้ใช้

