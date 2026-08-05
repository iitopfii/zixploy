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

/** Ownership labels — cleanup/reconciler เลือก resource จาก labels เหล่านี้เท่านั้น (ADR-0005) */
export const LABELS = {
  managed: "platform.managed",
  projectId: "platform.project_id",
  deploymentId: "platform.deployment_id",
  volumeId: "platform.volume_id",
} as const;
