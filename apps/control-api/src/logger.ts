import { createLogger, type Logger, type LogLevel } from "@zixploy/shared";

/**
 * Logger กลางของ Control API — ทุกบรรทัดผ่าน redaction (docs/threat-model.md)
 *
 * `log` เป็น proxy คงที่เพื่อให้ module อื่น import ครั้งเดียวได้
 * ส่วน implementation ข้างในเปลี่ยนได้ผ่าน configureLogger() ซึ่งใช้ในเทสต์
 * เพื่อดัก output จริงของ plugin มาตรวจว่าไม่มี secret หลุด
 */
function defaultLevel(): LogLevel {
  const configured = process.env.ZIXPLOY_LOG_LEVEL as LogLevel | undefined;
  if (configured) return configured;
  // ระหว่างเทสต์ให้เงียบ เว้นแต่ตั้งค่าเอง — ไม่ให้ access log กลบผลลัพธ์
  return process.env.NODE_ENV === "test" ? "error" : "info";
}

let current: Logger = createLogger({ service: "control-api", level: defaultLevel() });

export function configureLogger(options: { level?: LogLevel; sink?: (line: string) => void }) {
  current = createLogger({
    service: "control-api",
    level: options.level ?? defaultLevel(),
    ...(options.sink ? { sink: options.sink } : {}),
  });
}

export const log: Logger = {
  debug: (message, fields) => current.debug(message, fields),
  info: (message, fields) => current.info(message, fields),
  warn: (message, fields) => current.warn(message, fields),
  error: (message, fields) => current.error(message, fields),
};
