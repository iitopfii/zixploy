# Changelog

ทุก notable change ถูกบันทึกไว้ในไฟล์นี้ ตาม [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format  
Versioning: [Semantic Versioning](https://semver.org/)

---

## [Unreleased]

---

## [0.1.15] — 2026-08-20

### Fixed
- **volume ที่สั่งลบไม่ถูกลบสักที** — volume ที่ยังไม่เคยถูก deploy (Docker volume จริงยังไม่มี)
  จะค้างสถานะ "รอ worker ลบ…" ตลอดไป เพราะตัวตรวจ "ของถูกลบไปแล้ว" ของระบบไม่ครอบคลุม volume
  (ครอบแค่ container/image/network) คำสั่งลบจึงถูกนับเป็นความล้มเหลวแล้วถูกกลืนเงียบ ๆ ทุกรอบ ·
  ตอนนี้ลบสำเร็จตามปกติ และ volume ที่ค้างอยู่เดิมจะถูกเก็บกวาดเองภายใน 30 วินาทีหลังอัปเดต

### Changed
- **เข้มขึ้นกับ host path ที่ห้ามใช้ทำ bind mount** — เพิ่ม `/root` (ที่เก็บ SSH key ของผู้ดูแล),
  `/lib64` และโฟลเดอร์ติดตั้งของ Zixploy เอง (`/opt/zixploy` หรือที่ตั้งไว้ด้วย
  `ZIXPLOY_INSTALL_DIR`) — path อื่นใต้ `/opt` ยังใช้ได้ตามปกติ

---

## [0.1.14] — 2026-08-20

### Added
- **Volume แบบ bind mount (host path)** — ตอนสร้าง volume ระบุโฟลเดอร์บนเซิร์ฟเวอร์ได้เลย
  (เช่น `/home/mydata`) ข้อมูลจะไปอยู่ที่นั่นตรง ๆ เปิดดู/สำรองจาก host ได้ทันที · เว้นว่างไว้
  = ให้ Docker จัดการที่เก็บให้เหมือนเดิม (แนะนำ) · มีการตรวจ path อันตราย (`/etc`, `/usr`,
  `/var/lib/docker` ฯลฯ) และเปลี่ยน path ทีหลังไม่ได้ตามข้อจำกัดของ Docker เอง — เดิมต้องไปสร้าง
  volume เองบนเซิร์ฟเวอร์ด้วย `docker volume create -o type=none -o o=bind` ระหว่างที่หยุด worker ไว้
- **โหมด "TLS จัดการโดย proxy ภายนอก" ในหน้า Domains** — สำหรับคนที่รัน Zixploy หลัง Nginx
  Proxy Manager, Cloudflare หรือ load balancer ที่ terminate TLS มาให้แล้ว · ติ๊กครั้งเดียวปิด
  HTTPS + redirect ให้พร้อมกัน (เปิดไว้จะเกิด redirect วนซ้ำจนหน้าเว็บเปิดไม่ได้) · การ์ด domain
  เตือนอัตโนมัติเมื่อ DNS ชี้ผ่าน proxy แต่ยังเปิด HTTPS/redirect ไว้ · แก้ค่าเหล่านี้ของ domain
  ที่สร้างไปแล้วได้จากหน้าเว็บ (เดิมตั้งได้เฉพาะตอนสร้าง)
- **วันที่เผยแพร่ของเวอร์ชันใหม่ในตัวเช็คอัปเดต** — แสดงคู่กับเลขเวอร์ชันบนปุ่มอัปเดตและกล่อง
  ยืนยัน ทำให้เห็นทันทีถ้ามี tag ผิดปกติ (เลขสูงกว่าแต่ build เก่ากว่าที่รันอยู่)
- **ปุ่ม Redeploy บอก commit ที่จะ build** (เช่น `Redeploy f811672`) พร้อมคำอธิบายว่าเป็นการ
  build ซ้ำ commit เดิม ไม่ได้ดึงโค้ดล่าสุดจาก branch — ถ้าเพิ่ง push ต้องใช้ปุ่ม Deploy
- **แจ้งเตือนเมื่อแก้ environment variables หลัง deploy ล่าสุด** — ขึ้นแถบเตือนในแท็บ Deploy
  ว่าค่าใหม่ยังไม่มีผลจนกว่าจะ deploy อีกครั้ง

### Fixed
- **volume ที่เพิ่งสร้างไม่ถูกตีตราว่าเสียหายอีกต่อไป** — เดิม volume ที่สร้างจากหน้าเว็บจะกลาย
  เป็นสถานะ error ภายใน 30 วินาทีถ้ายังไม่ได้ deploy (เพราะ Docker volume จริงเกิดตอน deploy
  เท่านั้น) แล้วไม่มีทางกลับมาใช้งานได้เลย · ตอนนี้ระบบสร้าง Docker volume ให้เองและกู้สถานะ
  error ที่เกิดจากสาเหตุนี้กลับมาเป็นปกติอัตโนมัติ · ส่วน volume ที่เคยใช้งานจริงแล้วหายไปยังคง
  ขึ้น error พร้อมชี้ทางกู้คืนเหมือนเดิม
- **volume ที่ลบค้างบอกสาเหตุแล้ว** — เดิมค้างที่ "รอ worker ลบ…" ตลอดไปโดยไม่บอกอะไร ตอนนี้
  แสดงสาเหตุจริง เช่น ยังมี container ใช้ volume นี้อยู่ ต้อง deploy ใหม่ก่อนถึงจะลบได้

### Changed
- คำอธิบายใต้ช่อง **Exposed port** บอกชัดขึ้นว่าถ้าเข้าใช้งานผ่าน domain อยู่แล้วไม่จำเป็นต้อง
  ตั้งค่านี้ และการเว้นว่างทำให้ deploy ไม่มีช่วงดับ พร้อมได้การกู้คืนเวอร์ชันเก่าอัตโนมัติเมื่อ
  deploy ล้มเหลว

---

## [0.1.13] — 2026-08-20

### Fixed
- **deploy ที่ crash หลัง start ไม่ถูกนับว่าสำเร็จอีกต่อไป** — โปรเจกต์ที่ไม่ได้ตั้ง health check
  path เดิมระบบเช็คแค่ว่า container start ติดครั้งเดียว แอปที่ crash ในไม่กี่วินาทีถัดมา (เช่น env
  ขาด, config ผิด) จึงถูกนับเป็น deploy สำเร็จ: เวอร์ชันเก่าถูกถอดออกและ image เก่าถูกเก็บกวาด
  จน rollback ไม่ได้ เว็บล่มจนกว่าจะมาแก้มือ · ตอนนี้ระบบเฝ้าดู container ~10 วินาทีหลัง start —
  เห็น crash/restart เมื่อไหร่ deployment นับเป็นล้มเหลวทันที เวอร์ชันเก่ายังให้บริการต่อตามปกติ
  และ image เก่าไม่ถูกลบ (deployment ที่ล้มเหลวไม่กินโควต้า image retention แล้ว)
- **env ที่ฉีดเข้า deployment ไม่ได้ ไม่ผ่านเงียบ ๆ อีกต่อไป** — เดิมถ้าถอดรหัสค่าไม่ได้ (เช่น
  master key เปลี่ยน) ระบบข้าม key นั้นเงียบ ๆ container จึงรันแบบไร้ config โดยไม่มีใครรู้จนแอป
  พัง · ตอนนี้ถ้าตั้ง env ไว้แต่ฉีดเข้าไม่ได้เลยสักตัว deployment จะล้มเหลวทันทีพร้อมข้อความบอก
  วิธีแก้ (`ENV_INJECTION_FAILED`) และถ้าเสียเพียงบางตัวจะมี warning ระบุชื่อ key ใน deploy log
  — ครอบทั้งโปรเจกต์ปกติและ compose (ทั้ง env ระดับโปรเจกต์และระดับ component)

### Added
- **ปุ่ม "ตรวจสอบการถอดรหัส" ในแท็บ Environment** — เช็คได้ทุกเมื่อว่า env ทุกตัว (รวมของทุก
  component) ยังถอดรหัสได้ด้วย master key ปัจจุบันหรือไม่ พร้อมรายชื่อ key ที่เสียและวิธีแก้ —
  จับปัญหา master key เปลี่ยนได้ทันทีโดยไม่ต้องรอให้ deploy พังก่อน ไม่มี plaintext ใด ๆ ออกจาก
  server (endpoint ใหม่ `GET /api/v1/projects/:id/environment/health`)

---

## [0.1.12] — 2026-08-14

### Added
- **เมนู Docker** — หน้าใหม่ดูรายชื่อ container และ image ทั้งหมดบนเซิร์ฟเวอร์จาก dashboard
  โดยไม่ต้อง SSH เข้าไป `docker ps`/`docker images` เอง (อ่านอย่างเดียว):
  - แท็บ Containers: สถานะ (running/exited + ข้อความจาก Docker), image, ports พร้อมนับ
    ว่าทำงานอยู่กี่ตัว — รวม container ที่หยุดแล้วด้วย
  - แท็บ Images: repository/tag, ขนาด, วันที่สร้าง (รวม dangling image)
  - badge แยกว่าอันไหนเป็นของ Zixploy เอง อันไหนเป็น container/image อื่นที่รันอยู่บนเครื่อง
  - ค้นหาตามชื่อ/image ได้ · ข้อมูลอัปเดตอัตโนมัติทุก ~30 วินาที พร้อมแสดงเวลาอัปเดตล่าสุด
    (worker เป็นคนกวาดข้อมูลจาก Docker แล้วเก็บลงฐานข้อมูล — ตาราง snapshot ใหม่ migration 0026)

---

## [0.1.11] — 2026-08-13

### Added
- **compose: component-scoped environment variables** — ตั้ง env var แยกต่อ
  component ได้ (เช่น `web` กับ `worker` คนละชุด env) โดย override ค่าระดับโปรเจกต์ · หน้า
  Environment มีตัวเลือก "ขอบเขต" (ทั้งโปรเจกต์ / เจาะจง component) · ลำดับ override ตอน deploy:
  project-wide → managed_ref inject → component-scoped

### Changed
- rebuild ตาราง `environment_variables` (migration 0025): เปลี่ยน `UNIQUE(project_id,key)` ระดับ
  ตารางเป็น partial unique index สองอัน (project-scoped + component-scoped) ให้ key เดียวกันอยู่
  ได้ทั้งระดับโปรเจกต์และแยกต่อ component · `component_id` เพิ่ม `ON DELETE CASCADE` (ลบ component
  แล้ว env ที่ผูกไว้หายตาม) · env เดิมทั้งหมดถูกย้ายมาครบ (project-wide, component_id NULL)

---

## [0.1.10] — 2026-08-13

### Added
- **compose: depends_on แบบ `condition: healthy` ทำงานจริง** — เดิม UI ให้เลือก
  'healthy' ได้แต่ orchestrator ปฏิบัติเหมือน 'started' · ตอนนี้ตั้ง Docker-native HEALTHCHECK
  ต่อ component ได้ (ฟิลด์ `healthCmd` เช่น `pg_isready -U app`, `redis-cli ping`) แล้ว dependent
  จะรอ dependency ให้ healthy จริงก่อน start (dependency ที่ไม่มี healthcheck → fallback เป็น
  'started' พร้อม log เตือน ไม่ค้าง deploy)
- **compose: managed_ref เชื่อม managed database ได้จริง** — component ที่
  `depends_on` managed_ref จะได้ env เชื่อมต่อฉีดอัตโนมัติตอน deploy (`<NAME>_URL`, `_HOST`,
  `_PORT`, `_USERNAME`, `_PASSWORD`, `_DATABASE` — ถอดรหัสผ่าน + ประกอบ connection URI) และถูก
  ต่อเข้า proxy network อัตโนมัติเพื่อเข้าถึง service container (เดิม managed_ref แค่ verify ว่า
  service รันอยู่ ต่อ DB จริงไม่ได้)

---

## [0.1.9] — 2026-08-13

### Fixed
- **compose deploy: web health check ล้มเหลวบน production** (พบตอนทดสอบ E2E บน 103) — worker
  ต่ออยู่บน `zixploy-proxy`/`zixploy-internal` เท่านั้น ไม่ได้ต่อ per-deployment network ที่
  orchestrator สร้าง จึง HTTP-probe web container ผ่าน IP บน net นั้นไม่ถึง → deploy ล้มทุกครั้ง
  แก้ให้ probe web ผ่าน `zixploy-proxy` (web join ไว้แล้วสำหรับ Traefik เหมือน single-container)
  · non-web ที่ worker เข้าไม่ถึงจะข้าม HTTP gate (topological order ยังคุมลำดับ dependency อยู่)

---

## [0.1.8] — 2026-08-13

### Added
- **Multi-container (compose-style) projects** — โปรเจกต์เดียวรันได้หลาย container
  (เว็บ + worker + database) แบบ docker-compose:
  - แท็บ **Components** ใหม่ในหน้า project: เพิ่ม/แก้/ลบ component ทีละตัว (build จาก Dockerfile,
    image สำเร็จรูป, หรืออ้าง managed database), ตั้ง `depends_on` ระหว่าง component พร้อมเงื่อนไข
    (started/healthy) แล้วกด "เปลี่ยนเป็น compose" เมื่อพร้อม (ต้องมี ≥1 component + ≥1 web)
  - worker orchestrator ใหม่: build/pull ทุก component → สร้าง per-deployment network ที่ให้แต่ละ
    container คุยกันด้วย DNS alias (เช่น `redis://cache:6379`) → start ตามลำดับ topological +
    รอ health check ตามเงื่อนไข → activate ทับ generation เก่าแบบ start-before-stop
  - โปรเจกต์เดิม (mode='single') วิ่ง pipeline เดิม byte-for-byte — ฟีเจอร์นี้ opt-in ล้วน

### Notes
- managed_ref (อ้าง database ที่มีอยู่) เวอร์ชันนี้ verify ว่า service รันอยู่เท่านั้น — การ inject
  connection string อัตโนมัติ + component-scoped env/volume จะตามมาในรุ่นถัดไป

---

## [0.1.7] — 2026-08-13

### Fixed
- **Web Terminal พิมพ์ไม่ได้** — เปิด terminal เข้า database แล้วพิมพ์อะไรก็ไม่มีอะไรเกิดขึ้น:
  worker ใช้ `docker exec -i` (ไม่มี `-t` = ไม่มี PTY) จึงไม่มี terminal line discipline —
  Enter จาก xterm.js ส่ง `\r` (CR) แต่ `sh` รอ `\n` (LF) คำสั่งเลยไม่เคยรัน และไม่มี echo ให้เห็น
  สิ่งที่พิมพ์ แก้โดยครอบด้วย `script` (util-linux) ที่สร้าง PTY จริง — `docker exec -it` ยอมทำงาน
  แม้ stdin ของ worker เป็น pipe และ container ได้ PTY ครบ (echo + CR→LF + prompt + line editing)
  ตอนนี้ต่อ `psql`/`mysql`/`redis-cli` แล้วใช้งานได้จริง

### Security
- **แก้ปัญหา shell ค้างสะสมของ terminal (พบจากการตรวจสอบภายในก่อนปล่อยรุ่น)** — การปิด
  terminal session อาจทิ้ง shell ค้างไว้ในคอนเทนเนอร์ สะสมมากเข้าจนกระทบการทำงานของ database ได้
  ตอนนี้ระบบเก็บกวาด shell ที่ค้างให้อัตโนมัติทุกครั้งที่ปิด session

### Changed
- Terminal ตั้งขนาด PTY ตามขนาดจอจริงของ browser ตอนเปิด (แทน fixed 100x30) — mysql/psql จัดตาราง
  ได้พอดีตั้งแต่คำสั่งแรก
- ซ่อนปุ่ม Terminal + ปฏิเสธที่ control-api/worker สำหรับ engine ที่ image ไม่มี shell (libsql
  distroless) — เดิมกดแล้วเจอ OCI error งง ๆ ตอนนี้ไม่แสดงปุ่มเลย
- ปิด WebSocket ที่ค้างถ้า spawn terminal ล้มเหลว (กัน connection รั่ว)

---

## [0.1.6] — 2026-08-13

### Fixed
- **Dialog ของ Logs / Backups / Terminal ไม่แสดงผล** — กดปุ่มแล้วเหมือนไม่มีอะไรเกิดขึ้น ทั้งที่
  dialog เปิดอยู่จริงและโหลดข้อมูลสำเร็จแล้ว: component ทั้งสามใช้ `<Teleport to="body">` ย้าย DOM
  ออกไปนอก component tree ตัวเอง แต่เขียน `class="backdrop"` โดยไม่ได้นิยาม CSS ของมันในไฟล์ตัวเอง
  — scoped style ผูกกับ `data-v-<hash>` ของ component ที่**นิยาม** rule ไม่ใช่ของ component ที่
  render ตัว backdrop จึงไม่ได้ style เลย กลายเป็น block ธรรมดา (`position: static`) ไหลไปต่อท้าย
  `<body>` ใต้เนื้อหาหน้าเว็บ มองไม่เห็นจากใน viewport
  - ย้าย `.backdrop` ไปเป็น global utility ใน `main.css` (พร้อม comment อธิบายกับดักนี้ไว้กันพลาดซ้ำ)
    แล้วลบ definition ที่ซ้ำซ้อนออกจาก `ConfirmDialog.vue` และ `databases.vue`
  - เปลี่ยนชื่อ backdrop ของ mobile nav ใน layout เป็น `.nav-backdrop` — คนละหน้าที่/คนละ z-index
    กับ modal backdrop ไม่ควรใช้ชื่อ class ชนกัน
  - บั๊กนี้อยู่มาตั้งแต่ 0.1.3 (Logs) และติดมากับ 0.1.4 (Backups) กับ 0.1.5 (Terminal) เพราะแต่ละตัว
    copy โครง template มาโดยไม่ได้ copy CSS ของ `.backdrop` มาด้วย

---

## [0.1.5] — 2026-08-13

### Added
- **Web Terminal เข้า managed database** — เปิด shell เข้า container ของ database โดยตรงจาก
  หน้าเว็บ (ปุ่ม "Terminal" ที่การ์ดแต่ละ database ในหน้า Databases) ไม่ต้อง SSH เข้าเซิร์ฟเวอร์
  แล้ว `docker exec` เอง — ใช้ xterm.js เต็มรูปแบบพร้อม live output
  - สถาปัตยกรรม: control-api ไม่แตะ Docker เลย — แค่ relay byte ดิบระหว่าง
    WebSocket สองเส้น (browser กับ deploy-worker) worker เป็นฝ่าย exec เข้า container จริง
    แล้วต่อ WebSocket **ออกไปหา control-api เอง** ผ่าน internal Docker network โดยตรง
    (เพราะ worker ไม่มี server ของตัวเอง ไม่เคยรับ connection จากใครมาก่อน)
  - auth แยกสองชั้น: browser ใช้ session cookie ปกติเหมือนหน้าอื่น, worker ใช้ internal
    bearer token ที่สร้างอัตโนมัติตอนติดตั้ง — คนละหน้าที่
    จาก master key โดยสิ้นเชิง (ไม่เข้ารหัสอะไร แค่ยืนยันตัวตนระหว่างสอง service)
  - v1 ยังไม่ allocate PTY จริง (`docker exec -i` ไม่ใช่ `-it`) — คำสั่งพื้นฐานทำงานได้ปกติ
    (`psql`, `mysql`, `redis-cli`, `ls`, `cat` ฯลฯ) แต่ arrow-key history/tab completion/
    full-screen tool (`vim`, `less`, `top`) ยังใช้ไม่ได้ — ปรับปรุงต่อได้ในเวอร์ชันถัดไป

---

## [0.1.4] — 2026-08-13

### Added
- **Backup ของ managed database** — สำรองข้อมูลของ database ที่ deploy ผ่าน one-click services
  ได้ทั้งแบบตั้งเวลาอัตโนมัติและกดสำรองเองทันที เก็บไฟล์บน Docker volume เดิม
  (`zixploy-backups`) ที่ control-api ใช้ backup ตัวเองอยู่แล้ว:
  - ตั้งเวลาได้ 4 ความถี่ (ทุก 6/12/24 ชม. หรือทุกสัปดาห์) พร้อมกำหนดจำนวนที่เก็บไว้ล่าสุด
    (1-30 ชุด) — เกินจำนวนที่ตั้งไว้ backup เก่าสุดถูกลบทิ้งอัตโนมัติหลัง backup ใหม่สำเร็จ
  - PostgreSQL/MySQL/MariaDB/MongoDB สำรองแบบ live (`pg_dump`/`mysqldump`/`mongodump` ผ่าน
    `docker exec`) โดยไม่มี downtime; Redis/libSQL สำรองด้วยการหยุด container สั้น ๆ แล้ว
    tar ทั้ง data volume (ไม่มี dump tool ที่ปลอดภัยพอสำหรับสองตัวนี้)
  - ดาวน์โหลดไฟล์ backup, ลบ, และ **restore** ย้อนกลับได้จากหน้า Databases (ปุ่ม "Backups" ที่
    การ์ดแต่ละ database) — restore ต้องพิมพ์ชื่อ database ยืนยันก่อนเพราะเขียนทับข้อมูลปัจจุบัน
    ทั้งหมดและย้อนกลับไม่ได้
  - `GET/POST /api/v1/services/:id/backups`, `GET .../backups/:backupId/download`,
    `DELETE .../backups/:backupId`, `POST .../backups/:backupId/restore`

---

## [0.1.3] — 2026-08-13

### Added
- Logs ของ managed service (database) — เดิมมีแค่ log ของ project เท่านั้น ตอนนี้กด "Logs" ที่การ์ด
  database ในหน้า Databases ดู live tail ของ container (`postgres`/`mysql`/... init log ฯลฯ)
  ได้เลยโดยไม่ต้อง SSH เข้าเซิร์ฟเวอร์แล้ว `docker logs` เอง — ตาราง `service_logs` ใหม่ (ring
  buffer แยกจาก `runtime_logs` ของ project) + worker poller คู่ขนาน (`serviceLogLoop`) +
  `GET /api/v1/services/:id/logs` (paginated) และ `/logs/stream` (SSE live)
- การ์ด database แสดง **internal host เต็ม** (`zxsvc-<id>:<port>`) พร้อมปุ่ม copy โดยไม่ต้องเปิด
  modal "ข้อมูลเชื่อมต่อ" ก่อน — ลดขั้นตอนตอนต้องต่อ database จาก project อื่นในเซิร์ฟเวอร์เดียวกัน

### Fixed
- Secure flag ของ session/CSRF cookie ตัดสินจาก scheme ของ `ZIXPLOY_BASE_URL` แทน `NODE_ENV` —
  เดิมสมมติว่า "production = HTTPS เสมอ" ซึ่งไม่จริงกับการติดตั้งที่เข้าผ่าน IP ตรง ๆ (`http://<ip>`)
  ทำให้ตั้ง `NODE_ENV=production` ไม่ได้เลยโดยไม่ล็อกตัวเองออกจากระบบ (browser ทิ้ง Secure cookie
  ที่ส่งมาทาง HTTP)

- `/api/v1/system/health` ได้รับยกเว้นการตรวจ Host header — Docker healthcheck ยิงด้วย
  `Host: 127.0.0.1:3001` ซึ่งไม่มีทางอยู่ใน allowlist ตอน `NODE_ENV=production` ทำให้ได้ 400 →
  container unhealthy → Traefik ข้าม container → API ตายทั้งระบบ (endpoint นี้ไม่ต้อง auth,
  เป็น GET, และไม่สะท้อน Host กลับใน response จึงยกเว้นได้โดยไม่เปิดช่องโจมตี)

### Security
- ตั้ง `NODE_ENV=production` ให้ control-api ใน `deploy/server/docker-compose.yml` — เปิดการ
  ตรวจ Host header เข้มงวดตามที่ออกแบบไว้ (ตัด `localhost`/`127.0.0.1` ออกจาก allowlist)

---

## [0.1.2] — 2026-08-13

### Fixed
- Deploy จาก source แบบวาง Dockerfile ล้มเหลวทันที (0 วินาที) ด้วย "commitSha must be a hex SHA" —
  ตัวตรวจรูปแบบใน `imageName()` จำกัด commit SHA ที่ 40 ตัวอักษร (git SHA-1) แต่ source แบบนี้ใช้
  sha256 ของเนื้อหา (64 ตัว) เป็น commitSha สังเคราะห์ ขยาย validator เป็น 7–64 hex และเพิ่ม
  regression test ทั้งฝั่ง shared และ worker pipeline (เทสต์เดิมบังเอิญใช้ค่า 40 ตัวพอดีเลยไม่จับ)

---

## [0.1.1] — 2026-08-12

### Added
- **Exposed port ราย project** — เปิด host port ให้เข้าถึง container ตรง ๆ (เช่น host `3100` →
  container `3000`) ตั้งได้ที่ project → ตั้งค่า ตรวจ conflict กับ project อื่น/managed
  service/port ของระบบให้อัตโนมัติ
  - deploy ของ project ที่เปิด exposed port มี downtime สั้น ๆ ระหว่างสลับ container
    (host port ผูกได้ container เดียว จึงทำ start-before-stop ไม่ได้) — ถ้า deploy ใหม่
    ล้มเหลว ระบบ start container เก่าคืนให้อัตโนมัติ
- **Dashboard Domain** — หน้าตั้งค่าระบบใหม่ ตั้ง domain ที่ใช้เข้า dashboard ได้จาก UI
  มีผลทันทีไม่ต้อง restart (แก้ปัญหา `INVALID_HOST` โดยไม่ต้อง SSH ไปแก้ `.env`)
  พร้อมแสดง IP ของเครื่อง (A record) ให้คัดลอกไปตั้งค่า DNS
- Source แบบวาง Dockerfile ตรง ๆ แทนการเชื่อม GitHub repository (dashboard → Source tab)
- นำเข้า build config จาก docker-compose.yml (dashboard → Settings)
- ตัวติดตั้ง (`install.sh`) เปลี่ยน HTTP/HTTPS port ได้ผ่าน `ZIXPLOY_HTTP_PORT`/`ZIXPLOY_HTTPS_PORT`
- ตัวติดตั้งรองรับ `ZIXPLOY_DOMAIN` — ติดตั้งพร้อมใช้ domain ตั้งแต่แรกโดยไม่เจอ `INVALID_HOST`

### Fixed
- ตัวติดตั้งตั้ง `NODE_ENV=production` ให้ control-api — เปิดใช้ Secure cookie และการตรวจ
  Host header เข้มงวดตั้งแต่ติดตั้ง
- คำสั่งติดตั้งแบบตั้ง environment variable ใน README — รูปแบบเดิม (`VAR=x curl | sudo -E sh`)
  ตัวแปรไม่ถึงสคริปต์จริง เปลี่ยนเป็น `curl | sudo VAR=x sh`
- URL repository ใหม่หลังย้ายเป็น `github.com/iitopfii/zixploy`

---

## [0.1.0] — 2026-08-07

### Phase 8: Production Hardening

#### Added — M6: Production Docker Compose + Runbooks
- `deploy/control-plane/docker-compose.prod.yml` — production compose ครบ 4 services พร้อม resource limits, healthchecks, ACME TLS production
- `deploy/control-plane/.env.production.example` — template สำหรับ production environment variables
- `docs/runbooks/control-plane-down.md` — วินิจฉัยและแก้ไขเมื่อ Dashboard/API ไม่ตอบสนอง
- `docs/runbooks/deployment-stuck.md` — แก้ไข deployment ที่ค้างใน in-flight state
- `docs/runbooks/docker-daemon-unavailable.md` — recovery เมื่อ Docker daemon หยุด
- `docs/runbooks/disk-full.md` — ล้าง disk + ป้องกัน disk full ใน production
- `docs/runbooks/certificate-failed.md` — debug Let's Encrypt ACME failures
- `docs/runbooks/github-app-revoked.md` — กู้คืนเมื่อ GitHub App installation ถูกถอน
- `docs/runbooks/rotate-github-credentials.md` — rotate GitHub App private key + webhook secret อย่างปลอดภัย
- `docs/runbooks/release-checklist.md` — checklist ก่อน deploy ทุกครั้ง (CI, backup, smoke test, rollback plan)

#### Added — M5: Web Security Hardening
- HSTS header (`Strict-Transport-Security`) พร้อม preload
- Session token rotation หลัง login สำเร็จ (session fixation protection)
- Origin + Host validation middleware
- Security hardening integration tests

#### Added — M4: Backup Automation
- Automated backup: SQLite DB, master key envelope, ACME storage
- Backup retention policy (configurable, default 14 files)
- Backup CLI: `bun run cli:backup`
- Restore runbook: `docs/runbooks/backup-restore.md`

#### Added — M3: Audit Log
- Structured audit log สำหรับ login, project config changes, deploy/rollback triggers, volume deletion
- Audit events เก็บใน `audit_logs` table (migration 0010)

#### Added — M2: Reconciliation Loop
- General reconciliation loop สำหรับ degraded projects และ orphan container report
- Worker ตรวจสอบสุขภาพ container ที่รันอยู่ตาม schedule

#### Added — M1: Untrusted Build Sandbox
- Resource limits สำหรับ untrusted build: memory, cpu, nproc cgroup limits
- Workspace size assertion ก่อนเริ่ม build
- Build sandbox tests

---

### Phase 7: Volume Management

#### Added
- `volumes` table + migration 0009 พร้อม lifecycle state machine (`active → detached → deletion_pending → deleted | error`)
- Volume CRUD API: create, list, detach, delete (typed confirmation)
- Worker: attach/detach named volume จาก container ระหว่าง deploy
- Dashboard: Volumes tab พร้อม lifecycle badges, delete confirmation dialog (typed)
- `docs/runbooks/volume-backup-restore.md` — backup + restore named volume data

---

### Phase 6: Runtime Logs + Domain Management

#### Added
- Runtime log streaming: SSE `/api/v1/projects/:id/runtime-logs/stream`
- Build log: paginated GET + SSE stream สำหรับ in-flight deployment
- Domain CRUD API: add/remove/enable/disable custom domain
- DNS check service: verify A/CNAME record ชี้ถูกต้องก่อนออก cert
- Traefik label generator: generate จาก DB เท่านั้น (ไม่รับ raw label จาก user)
- Dashboard: Logs tab (build + runtime, SSE, auto-scroll), Domains tab (add/check/toggle/delete)

---

### Phase 5: Environment Variables

#### Added
- `env_vars` table + migration 0008: encryption envelope (AES-256-GCM) ต่อ variable
- Environment CRUD API: full-replace PUT, import .env, metadata-only GET (ไม่คืน plaintext)
- Worker: inject env vars เป็น BuildKit secrets (`--secret`) และ runtime env
- Key rotation CLI + runbook: `docs/runbooks/rotate-encryption-key.md`
- Dashboard: Environment tab พร้อม import, scope selector, secret masking

---

### Phase 4: Deploy Engine

#### Added (Phase 4 — deploy pipeline core)
- `deploy_jobs` + `deployments` tables + migration 0006 พร้อม state machine, partial indexes
- Deploy worker queue: claim/lease/renew/recover (lease recovery อัตโนมัติ)
- Build pipeline: `queued → cloning → building → starting → health_checking → activating → succeeded`
- Start-before-stop activation (ADR-0004): candidate ผ่าน health check ก่อนค่อย stop เก่า
- Cancel mechanism: `cancel_requested_at` ไม่ race กับ lease
- Cleanup worker: image retention (3 latest per project), workspace cleanup ใน `finally`
- Deploy timeout: `AbortController` ครอบทั้ง pipeline
- Crash-loop detection: `RestartCount` polling ระหว่าง health check
- Dashboard: Deploy tab พร้อม deployment list, status badges, cancel/rollback actions

---

### Phase 3: GitHub App Integration

#### Added
- GitHub App manifest flow: สร้าง App → callback → store (private key encrypted)
- Installation webhook: verify HMAC-SHA256 signature ก่อนประมวลผล
- Push webhook: enqueue deploy job อัตโนมัติเมื่อ push ถึง deploy branch
- Installation token minting: JWT → installation access token (worker มีสำเนา crypto code ของตัวเอง — ADR-0002)
- Git clone: `http.extraheader` authorization (token ไม่ปรากฏใน clone URL)
- `redactString()` สำหรับ stdout/stderr ก่อน log ใน clone/build step

---

### Phase 2: Auth + Project Management

#### Added
- SQLite migration runner + schema: users, sessions, projects, login_attempts (migrations 0001-0002)
- Auth: bcrypt password hash, session token (128-bit random), CSRF double-submit cookie
- Rate limiting: login 5 attempts / 15 min per IP
- Session expiry: configurable via `SESSION_TTL_HOURS`
- Project CRUD: create, list, get, update, archive
- Admin bootstrap CLI: `bun run cli:bootstrap-admin`
- Dashboard: login screen, app shell, project list, project overview, project settings

---

### Phase 1: Foundation

#### Added
- Bun monorepo workspace (`apps/control-api`, `apps/deploy-worker`, `apps/dashboard`, `internal/shared`, `internal/db`)
- TypeScript base config
- Elysia HTTP framework (control-api)
- Nuxt 3 (dashboard)
- Eden treaty typed API client
- SQLite via `bun:sqlite` (zero native dependency)
- Local dev stack: Traefik + docker compose dev
- CI: lint, typecheck, test, migrate:check
- Architecture enforcement test: `apps/control-api/test/architecture.test.ts`
- ADR-0001 through ADR-0005: key architectural decisions documented

---

[Unreleased]: https://github.com/iiTOPii/zixploy.com/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/iiTOPii/zixploy.com/releases/tag/v0.1.0
