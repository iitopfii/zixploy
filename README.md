<div align="center">

<img src="docs/brand/zixploy-mark.png" alt="" width="96">

# Zixploy

**Deployment platform สำหรับเซิร์ฟเวอร์เดียว**

deploy จาก GitHub · domain และ HTTPS อัตโนมัติ · ฐานข้อมูลสำเร็จรูป · ในที่เดียว

</div>

---

## ติดตั้ง

```bash
curl -sSL https://raw.githubusercontent.com/iitopfii/zixploy.com/main/deploy/install/install.sh | sudo sh
```

ตัวติดตั้งจะตรวจความพร้อมของเครื่อง ติดตั้ง Docker ให้ถ้ายังไม่มี สร้าง encryption key
แล้วเปิดระบบพร้อมบัญชีผู้ดูแลระบบชุดแรก — ใช้เวลาไม่กี่นาที

**ความต้องการขั้นต่ำ:** Linux (amd64 หรือ arm64) · RAM 2 GB · พื้นที่ว่าง 20 GB · port 80 และ 443 ว่าง

## ความสามารถ

| | |
|---|---|
| **Deploy จาก GitHub** | เชื่อม GitHub App เลือก repository และ branch — push แล้ว build/deploy อัตโนมัติ |
| **Zero-downtime** | container ใหม่ต้องผ่าน health check ก่อนจึงสลับ traffic — build ที่ล้มเหลวไม่กระทบเวอร์ชันที่ให้บริการอยู่ |
| **Rollback** | ย้อนกลับไป deployment ก่อนหน้าโดยไม่ต้อง build ใหม่ |
| **Domain + HTTPS** | ผูก domain แล้วออกใบรับรอง Let's Encrypt อัตโนมัติ หรืออัปโหลดใบรับรองเอง รองรับ Cloudflare proxy |
| **ฐานข้อมูลสำเร็จรูป** | PostgreSQL, MySQL, MariaDB, Redis, MongoDB, libSQL — กดสร้างแล้วได้ connection string ทันที |
| **Environment variables** | เข้ารหัส AES-256-GCM ก่อนบันทึก และกรองออกจาก log ทุกทาง |
| **Logs** | build log และ runtime log แบบสด ผ่าน SSE |
| **Monitoring** | CPU, หน่วยความจำ, ดิสก์ และ load ของเครื่อง รวมถึงทรัพยากรราย project |
| **Volumes** | จัดการ Docker volume พร้อมกันลบข้อมูลที่ยังถูกใช้งานอยู่ |
| **อัปเดตในตัว** | แจ้งเตือนเมื่อมีเวอร์ชันใหม่ กดอัปเดตได้จากหน้าเว็บ |

## สถาปัตยกรรม

```
                    ┌─────────┐
   :80 / :443  ───► │ Traefik │ ──► dashboard / control-api / แอปที่ deploy
                    └─────────┘
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
   ┌─────────┐    ┌─────────────┐   ┌──────────────┐
   │dashboard│    │ control-api │   │ deploy-worker│
   │  Nuxt   │    │   Elysia    │   │     Bun      │
   └─────────┘    └──────┬──────┘   └──────┬───────┘
                         │                 │
                         └──── SQLite ─────┘         Docker Engine
                              (คิวงาน)          ◄──── (worker เท่านั้น)
```

**control-api ไม่มีสิทธิ์เข้าถึง Docker socket** — งานทั้งหมดที่ต้องแตะ Docker ส่งผ่านคิวใน SQLite
ให้ worker ทำ ข้อจำกัดนี้บังคับด้วยเทสต์ที่จะล้มทันทีถ้ามีโค้ดแตะ Docker หลุดเข้ามาใน API

หลักการอื่นที่ตรึงไว้:

- deploy ทำผ่าน persistent queue — HTTP request ไม่รอ build จบ และงานไม่หายเมื่อ process ตาย
- ทุก resource ที่ระบบสร้างมี ownership label — cleanup จะไม่แตะของที่ไม่ใช่ของตัวเอง
- ความลับทุกชนิดเข้ารหัสก่อนบันทึก และผ่าน redaction ก่อนออก log

รายละเอียดการตัดสินใจเชิงสถาปัตยกรรมอยู่ใน [docs/adr/](docs/adr/)

## การใช้งาน

หลังติดตั้ง ระบบจะอยู่ที่ `http://<ip-เซิร์ฟเวอร์>` เข้าสู่ระบบด้วยบัญชีที่ตัวติดตั้งสร้างให้

```bash
cd /opt/zixploy

docker compose logs -f              # ดู log
docker compose restart              # รีสตาร์ท
docker compose pull && docker compose up -d   # อัปเดตด้วยตนเอง
```

### สำรองข้อมูล

ไฟล์ที่ต้องสำรอง:

| ไฟล์ | เนื้อหา |
|---|---|
| `/etc/zixploy/master.key` | กุญแจเข้ารหัส — **หายแล้วกู้ข้อมูลที่เข้ารหัสไว้ไม่ได้** |
| Docker volume `zixploy-data` | ฐานข้อมูลของระบบ |

## พัฒนา

```bash
bun install
ZIXPLOY_ADMIN_USERNAME=admin ZIXPLOY_ADMIN_PASSWORD='รหัสผ่านอย่างน้อย12ตัว' bun run bootstrap:admin
bun run dev
```

| Service | URL |
|---|---|
| Dashboard | http://localhost:3000 |
| Control API | http://127.0.0.1:3001 |

ทั้ง API และ Traefik bind เฉพาะ `127.0.0.1` ในโหมด dev — ไม่มี service ใดเปิดออก network ภายนอก

```bash
bun run lint           # Biome lint + format
bun run typecheck      # TypeScript ทุก workspace
bun test               # Unit + integration tests
bun run migrate:check  # ตรวจ migration ทั้ง up และ rollback
```

**หมายเหตุ**

- Nuxt dev server bind IPv6 — ใช้ `localhost:3000` ไม่ใช่ `127.0.0.1:3000`
- control-api เป็นผู้สร้างและ migrate ฐานข้อมูล worker จะรอไฟล์สูงสุด 30 วินาทีก่อนเริ่มทำงาน
- ปรับระดับ log ด้วย `ZIXPLOY_LOG_LEVEL` (`debug` / `info` / `warn` / `error`) ทุกระดับผ่าน redaction เสมอ

### โครงสร้าง

```
apps/
  dashboard/       Nuxt — UI
  control-api/     Elysia — HTTP API, ไม่แตะ Docker
  deploy-worker/   Bun — ผู้เดียวที่แตะ Docker Engine
internal/
  shared/          Types, state machine, error codes, service catalog
  db/              SQLite connection, migration runner, backup
migrations/        SQL migrations
deploy/install/    Production compose + installer
docs/              เอกสารออกแบบและ decision records
```

## ออกเวอร์ชันใหม่

```bash
git tag v0.1.0 && git push origin v0.1.0
```

CI จะ build image ทั้งสามตัวแบบ multi-arch (amd64/arm64) แล้ว push ไป GHCR
ระบบที่ติดตั้งอยู่จะเห็นเวอร์ชันใหม่และกดอัปเดตได้จากหน้าเว็บ
