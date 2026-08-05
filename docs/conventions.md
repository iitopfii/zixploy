# Conventions — API, Naming และ Supported Platforms

สถานะ: **ตรึงแล้ว (Phase 0)** — สิ่งที่อยู่ในไฟล์นี้เปลี่ยนภายหลังได้ยาก ต้องมี ADR ประกอบ

## Supported Platforms

| ส่วน | ข้อกำหนด |
|---|---|
| Production OS | Ubuntu 22.04/24.04 LTS หรือ Debian 12 (x86_64) |
| Docker Engine | >= 25.0 พร้อม BuildKit (buildx) |
| Bun | >= 1.3 (pin เวอร์ชันใน lockfile และ release image) |
| Development | Windows/macOS/Linux ที่มี Bun + Docker ได้ แต่ integration ที่แตะ Traefik ทดสอบบน Linux |

## API Conventions

### Prefix และ Versioning

- ทุก endpoint อยู่ใต้ **`/api/v1`**
- Breaking change ของ contract = bump เป็น `/api/v2` (ไม่คาดว่าจะเกิดใน MVP)
- Public ID เป็น **ULID** (sortable, ปลอดภัยกว่า row ID) — ไม่เปิดเผย SQLite row ID ใน API

### Request ID

- ทุก request ได้ `X-Request-Id` ใน response header
- ถ้า client ส่ง `X-Request-Id` มา (format ถูกต้อง, <= 64 chars) ใช้ค่าเดิม; ไม่งั้น generate ใหม่
- Request ID ปรากฏใน structured log ทุกบรรทัดที่เกี่ยวกับ request นั้น

### Error Envelope

ทุก error ตอบรูปแบบเดียวกัน:

```json
{
  "error": {
    "code": "PROJECT_NOT_FOUND",
    "message": "ข้อความอ่านได้สำหรับผู้ใช้",
    "requestId": "01J...",
    "details": {}
  }
}
```

กติกา:

- `code` เป็น `SCREAMING_SNAKE_CASE` และ **machine-readable** — UI ตัดสินใจจาก code ไม่ใช่ message
- `message` ปลอดภัยเสมอ (ไม่มี secret, ไม่มี internal path/stack trace)
- `details` optional สำหรับ validation errors (field-level)
- HTTP status ตรงตามหมวด: 400 validation, 401 unauthenticated, 403 forbidden/CSRF, 404 not found, 409 conflict, 422 unprocessable, 429 rate limited, 500 internal
- Error code ทั้งหมดประกาศใน `internal/shared` ที่เดียว

### Success Response

- ตอบ resource ตรง ๆ (ไม่ห่อ `data`) — consistency มาจาก typed contract ที่แชร์ระหว่าง Elysia และ Nuxt
- List endpoints ใช้ `{ items: [...], nextCursor?: string }` เมื่อต้องแบ่งหน้า

## Naming Conventions (Docker Resources)

ทุกชื่อ generate จาก immutable IDs เท่านั้น — **ห้าม** ประกอบจาก user input เช่น project name

```text
Image:      zixploy/<project-id>:<commit-sha7>-<deployment-id>
Container:  zx-<project-id>-<deployment-id>
Volume:     zxvol-<project-id>-<volume-id>
Network:    zixploy-proxy        (shared proxy network)
Workspace:  /var/lib/zixploy/workspaces/<deployment-id>
```

### Ownership Labels

ทุก resource ที่ระบบสร้าง (image, container, volume, network) ต้องติด labels:

```text
platform.managed=true
platform.project_id=<project-id>
platform.deployment_id=<deployment-id>   (เฉพาะ image/container)
platform.volume_id=<volume-id>           (เฉพาะ volume)
```

Cleanup **เลือกจาก labels เท่านั้น** และตรวจ project ID ซ้ำก่อนลบ — ไม่ลบ resource ที่ไม่มี `platform.managed=true` เด็ดขาด

### Immutability Rules

- Image tag ไม่ reuse — หนึ่ง deployment หนึ่ง tag; ห้ามใช้ `latest` เป็น source of truth
- บันทึก image digest หลัง build สำเร็จ; rollback อ้าง digest ไม่ใช่ tag

## Code Conventions

- TypeScript strict ทุก package, `verbatimModuleSyntax`
- Package names: `@zixploy/<name>` (เช่น `@zixploy/shared`, `@zixploy/control-api`)
- Route modules แยกตาม domain: `auth`, `projects`, `github`, `deployments`, `domains`, `logs`, `volumes`, `system`
- Lint/format ด้วย Biome; test ด้วย `bun test`
- Subprocess arguments เป็น array เสมอ — ห้ามต่อ shell string จาก user input
- โครงสร้าง: `apps/*` = process ที่รันได้, `internal/*` = library แชร์ (ห้ามมี side effect ตอน import)

## Ports (Local Development)

| Service | Port |
|---|---|
| Dashboard (Nuxt) | 3000 |
| Control API (Elysia) | 3001 |
| Traefik HTTP/HTTPS | 80 / 443 |
| Traefik dashboard (dev เท่านั้น) | 8080 |
