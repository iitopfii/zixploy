# Threat Model เบื้องต้น (Phase 0)

โฟกัสสี่พื้นที่เสี่ยงหลักตามที่กำหนดใน Phase 0: Docker socket, webhook, build และ secrets — ทบทวนอีกครั้งใน Phase 8

## สมมติฐานความเชื่อถือ

| ส่วน | ระดับความเชื่อถือ |
|---|---|
| Admin ที่ login แล้ว | เชื่อถือได้ (single admin คือ operator เอง) |
| Repository source / Dockerfile / build output | **ไม่เชื่อถือ** — อาจถูก compromise ผ่าน dependency |
| Webhook payload | **ไม่เชื่อถือ** จนกว่าจะผ่าน HMAC verification |
| Domain/hostname input | **ไม่เชื่อถือ** — validate + generate label เองเสมอ |
| Traffic จาก internet | ไม่เชื่อถือ |

## 1. Docker Socket (privilege สูงสุดในระบบ)

การเข้าถึง Docker socket = root บน host โดยพฤตินัย

| Threat | Mitigation |
|---|---|
| API ถูก compromise แล้วใช้ Docker socket ยึด host | API process **ไม่มีสิทธิ์เข้าถึง socket** — worker แยก process/service account เท่านั้นที่แตะ Docker |
| Worker ถูกหลอกให้สร้าง privileged container | Denylist ใน adapter: ห้าม `privileged`, host network, device mounts, extra capabilities, sensitive bind mounts (`/var/run/docker.sock`, `/proc`, `/sys`, `/dev`, `/`) — ตรวจ configuration ก่อน create ทุกครั้ง |
| Cleanup ลบ resource ของคนอื่นบน host | เลือก resource จาก `platform.managed=true` labels เท่านั้น + ตรวจ project ID ซ้ำ |
| Expose Docker TCP API | ไม่เปิด TCP API; ถ้าจำเป็นในอนาคตต้องมี mTLS (Phase 8) |

## 2. GitHub Webhook (endpoint สาธารณะ)

| Threat | Mitigation |
|---|---|
| Forged payload สั่ง deploy | ตรวจ HMAC-SHA256 แบบ constant-time กับ **raw body** ก่อน parse |
| Replay delivery เดิม | `webhook_deliveries.delivery_id` เป็น PK — ซ้ำ = ปฏิเสธ |
| Payload ขนาดใหญ่ทำ DoS | Request body size limit ก่อนอ่านทั้งก้อน |
| Push ไป branch/repo อื่นสั่ง deploy ข้าม project | ตรวจ installation ID + repository numeric ID + branch ตรงกับ project ก่อนสร้าง job |
| Webhook ทำงานช้า block GitHub | Persist event แล้วตอบทันที — ประมวลผลใน worker |

## 3. Untrusted Builds (โค้ดของ repo รันบนเครื่องเรา)

| Threat | Mitigation |
|---|---|
| Build ขโมย secret ของ platform | ไม่ mount control-plane files/env เข้า build; secret build-time ผ่าน BuildKit secrets เท่านั้น |
| Dockerfile path traversal ออกนอก workspace | Validate dockerfile path/build context อยู่ใน workspace ที่ isolate ต่อ deployment |
| Build กิน CPU/RAM/disk จน host ตาย | Resource limits + build timeout + workspace size limit + disk watermark (Phase 6) |
| Fork bomb / PID exhaustion | PID limit บน build/run containers |
| Container runtime หนีออก host | ไม่ให้ privileged/capabilities; pin Docker version ที่ patch แล้ว |
| Token รั่วใน build log | Installation token ไม่เข้า clone URL ที่ถูก log; ทุก output ผ่าน redaction pipeline |

## 4. Secrets

| Threat | Mitigation |
|---|---|
| DB ถูกอ่าน (backup หลุด, path traversal) | ทุก env value เข้ารหัส AES-256-GCM; master key อยู่นอก DB — ดู [encryption.md](encryption.md) |
| Secret รั่วผ่าน API | ไม่มี endpoint คืน plaintext; ตอบ `hasValue: true` เท่านั้น |
| Secret รั่วผ่าน log | Redaction pipeline ก่อน persist/stream ทุกทาง รองรับ secret ข้าม chunk; ไม่ log env map/Docker create request |
| GitHub token ระยะยาวรั่ว | ไม่มี PAT — App JWT + installation token อายุสั้น cache ใน memory เท่านั้น |
| GitHub App credentials ใน DB รั่ว (backup หลุด) | PEM/webhook secret/client secret เข้ารหัส AES-256-GCM envelope พร้อม AAD ผูก app+field; master key อยู่นอก DB — ดู [encryption.md](encryption.md) |
| Session hijack | httpOnly + Secure + SameSite cookie, session expiry, CSRF token สำหรับ mutation |
| Login brute force | Argon2id + rate limit + บันทึก failed attempts (ไม่เก็บ password ที่ลองผิด) |

## Attack Surface สาธารณะ (ตั้งใจให้เหลือน้อยที่สุด)

1. Traefik ports 80/443 → route ไป user apps + dashboard
2. `POST /api/v1/github/webhooks/:appId` (ผ่าน Traefik — secret เฉพาะต่อ app)
3. GitHub callback/setup URL
4. SSH ของ operator (นอก scope ระบบ แต่อยู่ใน checklist Phase 8)

ทุกอย่างอื่น (Docker API, SQLite, worker) ต้อง**ไม่** bind public interface

## Residual Risks (ยอมรับใน MVP — ทบทวน Phase 8)

- Build container ยังใช้ kernel ร่วมกับ host (ไม่มี VM isolation เช่น firecracker) — ยอมรับเพราะ admin เป็นคนเลือก repo เอง
- ไม่มี egress network policy ของ build ใน MVP หาก Docker รุ่นเป้าหมายไม่รองรับสะดวก
- Single admin = ไม่มี four-eyes สำหรับ destructive action — ชดเชยด้วย confirmation + audit events
