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
