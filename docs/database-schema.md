# Database Schema Design และ Migration Strategy

สถานะ: ออกแบบใน Phase 0 — สร้างจริงเป็น migration ตาม phase ที่ใช้งาน (ตารางไหนยังไม่ถึง phase ยังไม่ migrate)

## หลักการ

- SQLite เปิด `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000` ทุก connection
- Public ID เป็น **ULID** เก็บใน column `id TEXT PRIMARY KEY` — ไม่ใช้ `INTEGER PRIMARY KEY` เป็น public ID
- Timestamps เป็น `INTEGER` (Unix epoch มิลลิวินาที, UTC) ชื่อ `created_at`, `updated_at`
- Enum เก็บเป็น `TEXT` + `CHECK` constraint — ค่าที่ยอมรับประกาศคู่กันใน `internal/shared`
- Mutation ที่แตะหลายตารางต้องอยู่ใน transaction เดียว
- Soft delete ใช้ `archived_at` (nullable) — ไม่ลบ row ที่มี history

## ตาราง

### `users` (Phase 1)

| Column | Type | หมายเหตุ |
|---|---|---|
| `id` | TEXT PK | ULID |
| `username` | TEXT UNIQUE NOT NULL | |
| `password_hash` | TEXT NOT NULL | Argon2id |
| `created_at` / `updated_at` | INTEGER | |

### `sessions` (Phase 1)

| Column | Type | หมายเหตุ |
|---|---|---|
| `id` | TEXT PK | random token hash (เก็บ hash ไม่เก็บ token) |
| `user_id` | TEXT FK → users | |
| `expires_at` | INTEGER NOT NULL | |
| `created_at` | INTEGER | |
| `revoked_at` | INTEGER NULL | revoke all sessions = set ทุก row |

### `github_installations` (Phase 2)

| Column | Type | หมายเหตุ |
|---|---|---|
| `id` | TEXT PK | ULID |
| `installation_id` | INTEGER UNIQUE NOT NULL | จาก GitHub |
| `account_login` / `account_type` | TEXT | แสดงผลใน picker |
| `status` | TEXT CHECK | `active` / `suspended` / `deleted` |
| `created_at` / `updated_at` | INTEGER | |

### `projects` (Phase 1 core + ขยาย Phase 2/3)

| Column | Type | หมายเหตุ |
|---|---|---|
| `id` | TEXT PK | ULID |
| `name` | TEXT NOT NULL | display เท่านั้น — ไม่ใช้ประกอบชื่อ Docker resource |
| `status` | TEXT CHECK | `running` / `deploying` / `failed` / `stopped` / `new` |
| `installation_id` | TEXT FK NULL | Phase 2 |
| `repo_id` | INTEGER NULL | GitHub numeric ID (ทน rename) |
| `repo_full_name` | TEXT NULL | cache สำหรับแสดงผล |
| `branch` | TEXT NULL | |
| `auto_deploy` | INTEGER (bool) | default 0 |
| `dockerfile_path` | TEXT | default `Dockerfile` |
| `build_context` | TEXT | default `.` |
| `target_stage` | TEXT NULL | |
| `internal_port` | INTEGER NULL | |
| `health_check_*` | | path, interval, timeout, retries (Phase 3) |
| `start_command` | TEXT NULL | override |
| `cpu_limit` / `memory_limit` | | Phase 3 |
| `restart_policy` | TEXT | default `unless-stopped` |
| `deploy_timeout_sec` | INTEGER | |
| `archived_at` | INTEGER NULL | soft delete |
| `created_at` / `updated_at` | INTEGER | |

### `deployments` (Phase 3)

| Column | Type | หมายเหตุ |
|---|---|---|
| `id` | TEXT PK | ULID |
| `project_id` | TEXT FK NOT NULL | |
| `status` | TEXT CHECK | state machine ใน `internal/shared` |
| `trigger` | TEXT CHECK | `push` / `manual` / `redeploy` / `rollback` |
| `commit_sha` | TEXT NOT NULL | exact SHA |
| `commit_message` / `commit_author` | TEXT NULL | แสดงผล |
| `image_tag` | TEXT NULL | |
| `image_digest` | TEXT NULL | บันทึกหลัง build — ใช้ rollback |
| `container_id` | TEXT NULL | |
| `failure_code` | TEXT NULL | machine-readable |
| `failure_message` | TEXT NULL | สำหรับผู้ใช้ ผ่าน sanitize แล้ว |
| `queued_at` / `started_at` / `finished_at` | INTEGER | timeline |
| state timestamps | INTEGER NULL | `cloning_at`, `building_at`, `starting_at`, `health_checking_at`, `activating_at` |

### `deploy_jobs` (Phase 3) — durable queue

| Column | Type | หมายเหตุ |
|---|---|---|
| `id` | TEXT PK | ULID |
| `project_id` | TEXT FK NOT NULL | หนึ่ง active job ต่อ project (partial unique index) |
| `deployment_id` | TEXT FK NULL | |
| `type` | TEXT CHECK | `deploy` / `cleanup` |
| `status` | TEXT CHECK | `pending` / `leased` / `done` / `failed` / `cancelled` |
| `payload` | TEXT (JSON) | commit SHA ล่าสุด (coalesce ได้) |
| `priority` | INTEGER | manual > cleanup |
| `attempts` / `max_attempts` | INTEGER | ไม่ auto-retry build error |
| `lease_owner` | TEXT NULL | worker instance ID |
| `lease_expires_at` | INTEGER NULL | heartbeat ต่ออายุ; หมดอายุ = recover ได้ |
| `created_at` / `updated_at` | INTEGER | |

### `environment_variables` (Phase 4)

| Column | Type | หมายเหตุ |
|---|---|---|
| `id` | TEXT PK | |
| `project_id` | TEXT FK NOT NULL | UNIQUE(project_id, key) |
| `key` | TEXT NOT NULL | `[A-Za-z_][A-Za-z0-9_]*` |
| `value_ciphertext` | BLOB NOT NULL | AEAD envelope (nonce + key version + ciphertext) |
| `is_secret` | INTEGER (bool) | |
| `scope` | TEXT CHECK | `runtime` / `build` / `both` |
| `enabled` | INTEGER (bool) | |
| `version` | INTEGER | optimistic concurrency |
| `created_at` / `updated_at` | INTEGER | |

หมายเหตุ: เข้ารหัส **ทุกค่า** (ทั้ง plain และ secret) เพื่อให้ code path เดียว — `is_secret` ควบคุมเฉพาะการแสดงผล/redaction

### `domains` (Phase 5)

| Column | Type | หมายเหตุ |
|---|---|---|
| `id` | TEXT PK | |
| `project_id` | TEXT FK NOT NULL | |
| `hostname` | TEXT UNIQUE NOT NULL | canonical lowercase/punycode |
| `target_port` | INTEGER NOT NULL | |
| `https_enabled` | INTEGER (bool) | |
| `redirect_mode` | TEXT CHECK | `none` / `www-to-root` / `root-to-www` |
| `dns_status` | TEXT CHECK | `pending` / `valid` / `mismatch` / `unknown` |
| `dns_checked_at` | INTEGER NULL | |
| `route_status` / `cert_status` | TEXT | |
| `last_error` | TEXT NULL | sanitized |
| `created_at` / `updated_at` | INTEGER | |

### `volumes` (Phase 7)

| Column | Type | หมายเหตุ |
|---|---|---|
| `id` | TEXT PK | |
| `project_id` | TEXT FK NOT NULL | |
| `docker_name` | TEXT UNIQUE NOT NULL | `zxvol-<project-id>-<volume-id>` — generate เท่านั้น |
| `display_name` | TEXT NOT NULL | |
| `mount_path` | TEXT NOT NULL | absolute Linux path, ผ่าน denylist |
| `read_only` | INTEGER (bool) | |
| `access_mode` | TEXT CHECK | `shared-safe` / `single-writer` |
| `state` | TEXT CHECK | `active` / `detached` / `deletion_pending` / `deleted` / `error` |
| `created_at` / `last_attached_at` | INTEGER | |

### `webhook_deliveries` (Phase 2)

| Column | Type | หมายเหตุ |
|---|---|---|
| `delivery_id` | TEXT PK | `X-GitHub-Delivery` — PK = unique constraint สำหรับ idempotency |
| `event` | TEXT NOT NULL | |
| `payload` | TEXT (JSON) | เก็บหลัง verify signature แล้ว |
| `processed_at` | INTEGER NULL | |
| `received_at` | INTEGER NOT NULL | |

### `audit_events` (Phase 8 — เตรียมโครงไว้)

login, config change, deploy, rollback, volume deletion — `id`, `actor`, `action`, `entity_type`, `entity_id`, `metadata` (JSON, sanitized), `created_at`

## Migration Strategy

- Migration เป็นไฟล์ SQL ใน `migrations/` ชื่อ `NNNN_description.sql` เรียงลำดับตัวเลข
- แต่ละไฟล์มีสอง section คั่นด้วย marker:

```sql
-- migrate:up
CREATE TABLE ...;

-- migrate:down
DROP TABLE ...;
```

- Runner (ใน `internal/db`) เก็บสถานะในตาราง `schema_migrations(version TEXT PK, applied_at INTEGER)`
- แต่ละ migration รันใน transaction เดียว — fail = rollback ทั้งไฟล์
- **Up ต้องรันได้จากฐานข้อมูลว่างเสมอ** (CI ตรวจทุก commit)
- `down` ใช้เฉพาะ development — production ไม่ rollback schema (forward-fix เท่านั้น) และ backup อัตโนมัติก่อน migrate เสมอ (Phase 8)
- API/worker ตรวจว่า migration ครบก่อนรับงาน — เวอร์ชันไม่ตรง = fail closed
