/** API prefix เดียวของระบบ — ดู docs/conventions.md */
export const API_PREFIX = "/api/v1";

/** ชื่อ header สำหรับ request ID */
export const REQUEST_ID_HEADER = "X-Request-Id";

/** Docker network ที่ Traefik และ app containers ใช้ร่วมกัน */
export const PROXY_NETWORK = "zixploy-proxy";

/** Worker heartbeat: เขียนทุก HEARTBEAT_INTERVAL_MS; API ถือว่า worker ตายเมื่อเงียบเกิน STALE_MS */
export const WORKER_HEARTBEAT = {
  intervalMs: 5_000,
  staleMs: 15_000,
} as const;

/** Deploy job queue tuning (Phase 3, ADR-0003) */
export const DEPLOY_QUEUE = {
  /** worker poll interval เมื่อไม่มีงาน pending */
  pollIntervalMs: 2_000,
  /** อายุ lease ต่อการ claim หนึ่งครั้ง — เกินนี้แล้วไม่ renew ถือว่า worker ตาย */
  leaseMs: 60_000,
  /** ความถี่ในการต่ออายุ lease ระหว่างทำงาน (ต้อง < leaseMs มาก ๆ กันพลาด) */
  leaseRenewIntervalMs: 15_000,
} as const;

/** จำนวน image ของ deployment ที่ succeeded ล่าสุดต่อ project ที่เก็บไว้เสมอ (Phase 3 M7 cleanup) */
export const IMAGE_RETENTION_KEEP_COUNT = 3;

/**
 * Environment variable key format — [A-Za-z_][A-Za-z0-9_]*
 * ตรวจ client-side (validate endpoint) + server-side (store.ts) ทั้งคู่
 */
export const ENV_VAR_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * ความยาวขั้นต่ำของ secret value ที่จะใส่ใน redaction set
 * ค่าสั้นมาก (เช่น "1", "on") ทำให้ false positive สูง — skip ออกจาก set
 */
export const ENV_SECRET_MIN_REDACT_LENGTH = 4;

/** Log streaming + retention settings (Phase 6) */
export const LOG_SETTINGS = {
  /** เก็บ build_logs กี่วัน (นับจาก deployment finished_at) */
  buildRetentionDays: 30,
  /** จำนวนบรรทัด runtime log สูงสุดต่อ project (ring buffer) */
  runtimeRingSize: 2_000,
  /** ความถี่ poll DB สำหรับ SSE stream ของ build log */
  ssePollMs: 1_000,
  /** heartbeat interval สำหรับ SSE — ผ่าน reverse proxy timeout ได้ */
  sseHeartbeatMs: 15_000,
  /** ความถี่ poll `docker logs` สำหรับ runtime log (worker side) */
  runtimePollMs: 5_000,
  /** จำนวน log lines สูงสุดต่อ page ใน pagination */
  pageLimit: 500,
} as const;

/**
 * Resource monitoring (Phase 9)
 *
 * worker เก็บตัวอย่างทุก sampleIntervalMs → เขียน host_metrics/container_metrics
 * แล้ว prune แถวที่เก่ากว่า retentionMs ทุก pruneIntervalMs
 *
 * ที่ 15 วิ/ตัวอย่าง × 24 ชม. = 5,760 แถวสำหรับ host และ 5,760 แถวต่อ project
 * (10 project ≈ 63k แถว) — SQLite รับได้สบายและ prune เป็น DELETE ตามช่วง rowid ที่ต่อเนื่อง
 */
export const MONITORING = {
  /** ความถี่เก็บตัวอย่าง — ต่ำกว่านี้ `docker stats` (ซึ่งใช้เวลา ~1-2 วิ) จะซ้อนรอบตัวเอง */
  sampleIntervalMs: 15_000,
  /** อายุข้อมูลที่เก็บไว้ */
  retentionMs: 24 * 60 * 60 * 1000,
  /** ความถี่ prune — ไม่ต้องทุกรอบเก็บ เพราะ DELETE บ่อยเกินจำเป็นเปลือง I/O */
  pruneIntervalMs: 5 * 60 * 1000,
  /** ช่วงเวลาสูงสุดที่ API ยอมให้ query ย้อนหลัง (กัน range ใหญ่เกินจนดึงทั้งตาราง) */
  maxRangeMs: 24 * 60 * 60 * 1000,
  /**
   * จำนวนจุดสูงสุดที่ API คืนต่อหนึ่ง series — เกินนี้จะ downsample ด้วยการหยิบทุก ๆ N จุด
   * (กราฟกว้าง ~900px วาดละเอียดกว่านี้ก็ไม่เห็นความต่าง แต่ payload โตขึ้นหลายเท่า)
   */
  maxSeriesPoints: 480,
} as const;

/**
 * System maintenance (Phase 11 — ล้าง cache/ขยะที่กินดิสก์)
 *
 * BuildKit cache โตไม่จำกัดตามจำนวน build — บนเครื่องเล็กเป็นสาเหตุอันดับหนึ่งที่ดิสก์เต็ม
 * แล้ว deploy ครั้งถัดไปพังด้วย DISK_FULL
 */
export const MAINTENANCE = {
  /** งาน prune หนึ่งครั้งนานสุดก่อนถือว่าค้าง */
  jobTimeoutMs: 600_000,
  /** worker poll คิว maintenance ทุกกี่ ms */
  pollIntervalMs: 5_000,
  /**
   * เก็บ build cache ที่ยังใช้อยู่ล่าสุดไว้เท่านี้ (ชั่วโมง) — ตัดของเก่ากว่านี้ทิ้ง
   * ไม่ล้างทั้งหมดโดย default เพราะ build ถัดไปจะช้ามากถ้าไม่มี cache เลย
   */
  keepCacheHours: 168,
} as const;

/** Docker volume driver ที่อนุญาต — MVP: local เท่านั้น (Phase 7) */
export const VOLUME_ALLOWED_DRIVERS = ["local"] as const;
export type VolumeDriver = (typeof VOLUME_ALLOWED_DRIVERS)[number];

/**
 * Container path prefixes ที่ห้าม mount volume — threat-model.md (Phase 7)
 * ตรวจสองชั้น: validateMountPath() ที่ API และ assertDockerArgsSafe() ที่ worker (defense-in-depth)
 */
export const VOLUME_SENSITIVE_PATHS = [
  "/proc",
  "/sys",
  "/dev",
  "/etc",
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/run/docker.sock",
  "/var/run/docker.sock",
  "/.dockerenv",
] as const;

/**
 * Sandbox limits สำหรับ `docker buildx build` เอง (RUN instructions ระหว่าง build) — threat-model.md
 * section 3 "Build กิน CPU/RAM/disk จน host ตาย" / "Fork bomb / PID exhaustion"
 * ต่างจาก ContainerCreateParams.cpuLimit/memoryLimitMb/pidsLimit ซึ่งเป็น limit ของ container
 * ตอน runtime (Phase 0-3) — อันนี้ครอบเฉพาะ build step ที่ยังไม่เคยจำกัดมาก่อน (Phase 8 M1)
 */
export const BUILD_SANDBOX_LIMITS = {
  memoryMb: 2048,
  cpuQuota: 100_000,
  cpuPeriod: 100_000,
  nprocSoft: 512,
  nprocHard: 512,
  /** ขนาดรวมของ workspace (หลัง clone) ก่อนเริ่ม build — ป้องกัน repo/objects ขนาดใหญ่ผิดปกติ */
  workspaceMaxMb: 2048,
} as const;

/** Ownership labels — cleanup/reconciler เลือก resource จาก labels เหล่านี้เท่านั้น (ADR-0005) */
export const LABELS = {
  managed: "platform.managed",
  projectId: "platform.project_id",
  deploymentId: "platform.deployment_id",
  volumeId: "platform.volume_id",
  /** managed service (database) — Phase 10 */
  serviceId: "platform.service_id",
} as const;

/**
 * Managed services (Phase 10 — one-click databases)
 */
export const SERVICE_SETTINGS = {
  /** ความยาวรหัสผ่านที่ generate (ตัวอักษร base62 → ~178 bit entropy) */
  passwordLength: 30,
  /** ช่วง port ที่ยอมให้เปิดออก host — ต่ำกว่า 1024 เป็น privileged, สูงกว่านี้ชน ephemeral range */
  exposedPortMin: 1024,
  exposedPortMax: 60000,
  /**
   * Port ที่ระบบใช้เองอยู่แล้ว — เปิดทับจะทำให้ Traefik/SSH ล่ม
   * ตรวจที่ API ก่อนบันทึก (worker ตรวจซ้ำอีกชั้นตอน create)
   */
  reservedPorts: [22, 80, 443, 3000, 3001] as readonly number[],
  /** memory limit เริ่มต้นต่อ service — database ไม่จำกัดเลยเสี่ยงกิน RAM จนเครื่องตาย */
  defaultMemoryMb: 512,
  /** รอ container ขึ้นเป็น healthy นานสุดก่อนถือว่า provision ล้มเหลว */
  readyTimeoutMs: 180_000,
} as const;

/**
 * Managed service backups (Phase 16)
 *
 * เก็บบน Docker volume เดิมที่ control-api ใช้ backup ตัวเอง (zixploy-backups) แยก subdirectory
 * "services/<serviceId>/" — deploy-worker mount volume เดียวกันเพิ่ม (docker-compose.yml)
 */
export const SERVICE_BACKUP_SETTINGS = {
  /** เก็บ backup ไว้กี่ชุดต่อ service ก่อนลบตัวเก่าสุดทิ้ง (ค่า default ตอนสร้าง service) */
  defaultRetentionCount: 7,
  retentionMin: 1,
  retentionMax: 30,
  /** ตัวเลือก interval ที่ตั้งได้ผ่าน UI — จำกัดตัวเลือกแทนรับ cron expression ดิบ กันตั้งผิดพลาด */
  allowedIntervalHours: [6, 12, 24, 168] as readonly number[],
  /** ทุกกี่วิ scheduler loop เช็คว่ามี service ไหนถึงกำหนด backup แล้วบ้าง */
  scheduleCheckIntervalMs: 5 * 60 * 1000,
  /** timeout ของคำสั่ง dump/restore หนึ่งครั้ง — database ใหญ่ใช้เวลานานกว่า docker command ปกติมาก */
  dumpTimeoutMs: 30 * 60 * 1000,
} as const;

/**
 * Interactive terminal เข้า container ของ managed service (Phase 17)
 *
 * worker ไม่มี server ของตัวเอง (ADR-0002) — เปิด terminal ทำผ่านตาราง terminal_sessions
 * เป็น "กระดานงาน": control-api สร้างแถว pending แล้วรอ, worker poll เจอแล้วต่อ WebSocket
 * กลับมาหา control-api เอง (ผ่าน zixploy-internal network ตรง ๆ ไม่ผ่าน Traefik) จากนั้น
 * control-api แค่ relay byte ระหว่าง browser WS กับ worker WS สอง socket ที่มันถืออยู่
 * ไม่ต้องเข้าใจความหมายของข้อมูลเลย (ดู apps/control-api/src/routes/terminal.ts)
 *
 * Message framing บน WebSocket ทั้งสอง hop เดียวกัน — control-api relay แบบ raw ไม่แปลง:
 * - binary frame  = terminal I/O byte ดิบ ทั้งสองทิศทาง (keystroke ↔ stdout/stderr)
 * - text frame    = JSON control message ทิศทาง browser → worker เท่านั้น เช่น
 *                   {"type":"resize","cols":80,"rows":24}
 */
export const TERMINAL_SETTINGS = {
  /** worker poll หา session pending ถี่แค่ไหน — ต้องไวเพราะผู้ใช้รอเปิด terminal อยู่สด ๆ
   *  (ต่างจาก backupScheduleLoop ที่ poll เป็นนาทีได้เพราะไม่มีใครรอสด ๆ) */
  pollIntervalMs: 1_000,
  /** worker รอให้มี session pending ให้ claim ได้นานสุดกี่ครั้ง poll ก่อน timeout ฝั่ง browser
   *  (ดู browserWaitTimeoutMs) — ใช้คำนวณ retry ฝั่ง worker log เท่านั้น ไม่ใช่ hard limit */
  claimPollAttempts: 30,
  /** browser รอ worker มา claim+connect นานสุดกี่ ms ก่อน control-api ปิด connection เอง
   *  (เผื่อ worker ตาย/ไม่มี worker อยู่เลย — ไม่ปล่อยให้ browser ค้างเงียบตลอดไป) */
  browserWaitTimeoutMs: 15_000,
  /** ปิด session อัตโนมัติถ้าไม่มี input/output ไหลผ่านเลยนานเท่านี้ — กัน `docker exec` ค้าง
   *  ตลอดไปถ้า browser หลุดกะทันหันแบบไม่ส่ง close frame (เช่น ปิด tab หรือเน็ตหลุด) */
  idleTimeoutMs: 30 * 60 * 1000,
  /** shell ที่ exec เข้าไป — "sh" มีในทุก base image ที่ catalog ใช้ (แม้แต่ alpine-based) */
  shell: "sh",
} as const;
