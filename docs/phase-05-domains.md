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
- แสดง `pending`, `valid`, `mismatch`, `unknown`
- DNS mismatch ไม่จำเป็นต้องห้าม save แต่ต้องเตือนก่อนเปิด HTTPS
- ใช้ timeout/cache เพื่อไม่ให้ DNS resolver ทำ API ช้า

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
- ใช้ staging ACME ใน test environment
- backup certificate storage แต่ไม่แชร์ file storage ระหว่างหลาย Traefik instances

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

