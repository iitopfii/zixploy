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

/** Ownership labels — cleanup/reconciler เลือก resource จาก labels เหล่านี้เท่านั้น (ADR-0005) */
export const LABELS = {
  managed: "platform.managed",
  projectId: "platform.project_id",
  deploymentId: "platform.deployment_id",
  volumeId: "platform.volume_id",
} as const;
