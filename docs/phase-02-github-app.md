# Phase 2 — GitHub App และ Repository Picker

## เป้าหมาย

ให้ Admin เชื่อม GitHub App เลือก personal/organization installation, repository และ branch ได้ โดยรองรับ private repositories และไม่เก็บ Personal Access Token ระยะยาว

## GitHub App Configuration

### Repository permissions ขั้นต่ำ

- Metadata: Read (GitHub ให้โดยปริยาย)
- Contents: Read

### Webhook subscriptions

- `push`
- `installation`
- `installation_repositories`

### Secrets/configuration

- App ID
- Client ID/Client Secret เฉพาะกรณีใช้ user authorization
- Private key (PEM)
- Webhook secret
- Callback URL และ Setup URL

สำหรับ single-admin สามารถเริ่มด้วย installation flow โดยไม่ขอ user-to-server authorization หากระบบระบุ installation จาก callback/setup และตรวจความเป็นเจ้าของได้เพียงพอ

## User Flow

```mermaid
sequenceDiagram
    participant A as Admin
    participant P as Platform
    participant G as GitHub
    A->>P: Connect GitHub
    P->>G: Open installation page
    A->>G: Select account and repositories
    G->>P: Installation/setup callback
    P->>G: Create short-lived installation token
    P->>G: List accessible repositories
    A->>P: Select repository and branch
    P->>P: Save immutable repository ID and configuration
```

## API Surface

```text
GET    /api/v1/github/status
GET    /api/v1/github/install-url
GET    /api/v1/github/callback
GET    /api/v1/github/installations
GET    /api/v1/github/installations/:id/repositories
GET    /api/v1/github/branches
POST   /api/v1/github/webhooks
POST   /api/v1/projects/:id/source
DELETE /api/v1/projects/:id/source
```

## Token Strategy

- สร้าง GitHub App JWT (RS256) อายุสั้น (9 นาที) เมื่อต้องเรียก installation API
- สร้าง installation token เฉพาะเมื่อ list/validate repo/branch
- cache token ใน memory ได้ไม่เกินอายุ token ลบด้วย 5 นาที safety margin
- **ไม่เก็บ** installation token ลง DB
- ไม่เขียน token ลง clone URL, process output หรือ deployment log
- Private key อยู่ใน filesystem เท่านั้น ไม่ส่งออก response ใดๆ
- CryptoKey cache ใน factory closure — import PEM ครั้งเดียว ไม่ re-parse ทุก JWT call

## Repository Picker Requirements

- แสดง account avatar/name และ account type
- Search และ pagination
- แสดง private/public และ default branch
- กรองเฉพาะ repository ที่ installation เข้าถึงได้
- Branch picker แบบค้นหาและแบ่งหน้า
- เก็บ repository numeric ID + full name เพื่อรับมือ rename
- Refresh เมื่อได้รับ `installation_repositories`
- ปิด Auto Deploy หาก installation ถูก suspended/deleted หรือ repository ถูกถอนสิทธิ์

## Webhook Handling

- อ่าน raw request body ก่อน parse
- ตรวจ HMAC-SHA256 signature แบบ constant-time (WebCrypto)
- Atomic `INSERT OR IGNORE` บน `delivery_id` (PRIMARY KEY) — ป้องกัน race condition
- Compare-and-set UPDATE เพื่อ claim processing lease (30 วินาที)
- Webhook processing state machine: `received → processing → processed | failed`
- Failed delivery retry: attempt_count < MAX_WEBHOOK_ATTEMPTS (3) → eligible for retry
- Stale lease recovery: processing นานกว่า 30s → reclaimable
- Permanent failure: invalid JSON → attempt_count exhausted → ไม่ retry
- Deploy intent สร้างด้วย `INSERT OR IGNORE` ป้องกัน intent ซ้ำ (UNIQUE INDEX บน `project_id + delivery_id`)

## Webhook Branch Validation

- `validateBranch` ใช้ `GET /repos/{owner}/{repo}/branches/{branch}` โดยตรง
- รองรับ repository ที่มี >100 branches (ไม่ต้อง paginate)
- GitHub ตอบ 404 ถ้า branch ไม่มีอยู่ → AppError("INSTALLATION_NOT_FOUND")

## GitHub Client Security

- Path segments encode ด้วย `encodeURIComponent` (owner, repo, branch name)
- Response size ตรวจเป็น byte (`Buffer.byteLength`) ไม่ใช่ JS char count
- JSON.parse ครอบด้วย try-catch → AppError (ไม่ให้ SyntaxError leak)
- Response shape validation: ตรวจ required fields ก่อน cast
- ไม่ log Authorization header, JWT, หรือ access token ใน error message

## งานดำเนินการ

- [x] Migration 0003: `github_installations`, `webhook_deliveries`, `deploy_intents`
- [x] Migration 0004: webhook processing state machine + deploy_intent UNIQUE INDEX
- [x] GitHub App config loader (env vars, lazy validation, null if unconfigured)
- [x] JWT signer (RS256, PKCS#1→PKCS#8 via manual ASN.1, WebCrypto)
- [x] Installation token cache (in-memory Map, 5-min safety margin)
- [x] GitHub HTTP client (typed, 15-sec timeout, path encoding, byte-accurate size, shape validation, error mapping)
- [x] GitHubService interface + RealGitHubService factory (CryptoKey cache, direct branch lookup)
- [x] Control API routes: 6 GitHub routes + POST/DELETE project source
- [x] Webhook route (raw body, HMAC-SHA256, atomic idempotency, processing lease, state machine, push/installation/repos events)
- [x] Dashboard: GitHubConnect.vue (configured/no-install/has-install states)
- [x] Dashboard: RepositoryPicker.vue (search, pagination, branch selection)
- [x] Dashboard: [id].vue Source tab (connected/revoked/picker states)
- [x] Log redaction for webhook_secret, pem, clone_url, access_token, JWT, GitHub tokens
- [x] Tests: JWT signing (10), token cache (10), webhook verification (unit + endpoint), GitHub routes, GitHub client (path encoding, error mapping, shape validation), webhook state machine

## การทดสอบ

- [x] JWT: 3-part structure, RS256 header/payload claims, signature verify, tamper detection, PKCS#8 import
- [x] Token cache: empty state, valid get, expiry, safety margin, invalidate, multi-installation
- [x] Webhook signature: correct/wrong/null/no-prefix/body-tampered/wrong-secret
- [x] Webhook endpoint: valid/invalid signature → 200/401, duplicate delivery idempotent
- [x] Push events: correct branch creates intent, wrong branch/auto_deploy=0/deleted/tag → no intent
- [x] Single push creates exactly 1 intent even sent twice
- [x] Installation lifecycle: deleted/suspended/unsuspended → DB state + auto_deploy off
- [x] Repository removed → auto_deploy disabled for affected repos only
- [x] GitHub routes: all 8 endpoints, auth enforcement, CSRF, GITHUB_UNAVAILABLE when unconfigured
- [x] Webhook state machine: atomic claim (only 1 of 2 concurrent claims succeeds), processed duplicate returns duplicate:true
- [x] Invalid JSON → 400, delivery marked failed (INVALID_PAYLOAD), attempt_count exhausted → no retry
- [x] Failed delivery (attempt < max) → retry via redeliver → processed
- [x] Stale processing lease (>30s) → recovery claim succeeds → processed
- [x] Exhausted delivery (attempt = max) → redeliver returns duplicate:true, status unchanged
- [x] deploy_intent UNIQUE INDEX: INSERT OR IGNORE on same (project_id, delivery_id) → 0 changes
- [x] GitHub client: path encoding, 4xx/5xx error mapping, malformed JSON, oversized response, missing fields, network error, timeout

## Validation Results (Phase 2 hardening)

```
bun install --frozen-lockfile                    ✅  no changes
bun run lint                                     ✅  0 errors, 5 warnings (pre-existing Nuxt)
bun run typecheck                                ✅  0 errors across 5 workspaces
bun test                                         ✅  216 tests pass, 0 fail
bun run migrate:check                            ✅  4/4 up, 4/4 down
bun run --filter @zixploy/dashboard build        ✅  build complete
```

## Exit Criteria

- [x] เชื่อม GitHub App และเลือก private repository/branch ผ่าน UI ได้ (mock-validated)
- [x] Webhook ที่ผ่านการตรวจสอบสร้าง deploy intent อย่าง idempotent (atomic INSERT OR IGNORE + DB UNIQUE INDEX)
- [x] ไม่มี installation token ระยะยาวใน DB
- [x] Installation lifecycle สะท้อนใน Dashboard ถูกต้อง (revoked warning)
- [x] All GitHub routes validated; no tokens in browser responses
- [x] Webhook processing state machine: recovery, retry, exhausted — tested at DB level
- [ ] Manual end-to-end test with real GitHub App (requires real App registration — mock-validated; real-app test deferred to staging)

## Mock-Only Items (Phase 2)

รายการต่อไปนี้ผ่าน tests โดย mock GitHub API — **ยังไม่ได้ทดสอบกับ GitHub จริง**:

- Real RS256 JWT accepted by GitHub API
- Installation token exchange over live HTTPS
- Real webhook delivery from GitHub servers
- Branch validation via live `GET /repos/{owner}/{repo}/branches/{branch}`
- Path encoding behavior with real GitHub owner/repo names containing special chars

Phase 3 staging environment จะทดสอบ end-to-end flow เหล่านี้

## ไม่เริ่มในเฟสนี้ (Phase 3–8)

- Deploy Engine (Docker build/run)
- Environment variables management
- Domain routing
- Log streaming
- Volume management
