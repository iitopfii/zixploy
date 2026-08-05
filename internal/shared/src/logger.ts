/**
 * Structured JSON logging พร้อม redaction (docs/phase-01, docs/threat-model.md)
 *
 * กติกาเดียวของระบบ: ห้าม cookie, password, session token หรือ CSRF token
 * ปรากฏใน log ไม่ว่าจะ level ใด รวมถึง debug
 *
 * Phase 4 จะต่อยอด redactor นี้ด้วย secret values จาก environment variables
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** field ที่ห้าม log ค่าจริงเด็ดขาด — เทียบแบบ case-insensitive และ substring */
const SENSITIVE_KEY_PATTERNS = [
  "password",
  "passwd",
  "secret",
  "token",
  "cookie",
  "authorization",
  "auth",
  "session",
  "csrf",
  "credential",
  "apikey",
  "api_key",
  "private_key",
  "privatekey",
];

export const REDACTED = "[redacted]";

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** รูปแบบ credential ที่อาจฝังอยู่ในข้อความ เช่น URL ที่มี user:pass@ */
const CREDENTIAL_URL_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const BEARER_RE = /\b(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const COOKIE_PAIR_RE = /\b(zx_session|zx_csrf)=[^;\s]+/gi;

export function redactString(value: string): string {
  return value
    .replace(CREDENTIAL_URL_RE, `$1${REDACTED}@`)
    .replace(BEARER_RE, `$1 ${REDACTED}`)
    .replace(COOKIE_PAIR_RE, `$1=${REDACTED}`);
}

/**
 * ตัดค่า sensitive ออกจาก object ก่อน serialize
 * ทำงานแบบ recursive และตัด cycle เพื่อไม่ให้ JSON.stringify พัง
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redact(item, seen);
  }
  return out;
}

export interface LogFields {
  // รับ undefined ได้ตรง ๆ (exactOptionalPropertyTypes) — ค่าที่ไม่มีจะถูกตัดตอน serialize
  requestId?: string | undefined;
  projectId?: string | undefined;
  deploymentId?: string | undefined;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  service: string;
  level?: LogLevel;
  /** ฉีด sink ได้เพื่อทดสอบ — ค่าเริ่มต้นเขียน stdout */
  sink?: (line: string) => void;
}

export function createLogger(options: LoggerOptions): Logger {
  const minimum = LEVEL_ORDER[options.level ?? "info"];
  const sink = options.sink ?? ((line: string) => console.log(line));

  function emit(level: LogLevel, message: string, fields?: LogFields) {
    if (LEVEL_ORDER[level] < minimum) return;
    const safeFields = fields ? (redact(fields) as Record<string, unknown>) : {};
    sink(
      JSON.stringify({
        level,
        service: options.service,
        message: redactString(message),
        ...safeFields,
      }),
    );
  }

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
