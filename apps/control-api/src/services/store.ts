/**
 * Managed service storage — Phase 10 M2
 *
 * รหัสผ่านเข้ารหัสด้วย AES-256-GCM (docs/encryption.md) ก่อน persist เสมอ
 * AAD: "service:<id>:password" — ย้าย ciphertext ข้าม service ไม่ได้
 *
 * API ไม่คืนรหัสผ่านใน list/get ปกติ — ต้องเรียก endpoint credentials แยกที่ตั้งใจ
 * (เหมือน env vars ที่คืนแค่ hasValue) worker อ่านผ่าน DB โดยตรง ไม่ผ่าน HTTP (ADR-0002)
 */

import type { Database } from "bun:sqlite";
import {
  AppError,
  getTemplate,
  resolveVersion,
  SERVICE_SETTINGS,
  type ServiceCredentials,
  type ServiceType,
  serviceImage,
  serviceVolumeName,
  ulid,
} from "@zixploy/shared";
import { decryptEnvelope, encryptEnvelope } from "../crypto/envelope";
import type { MasterKeys } from "../crypto/master-key";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServiceStatus = "creating" | "starting" | "running" | "stopped" | "failed" | "deleting";

export interface ServiceRow {
  id: string;
  name: string;
  type: string;
  version: string;
  image: string;
  status: string;
  container_id: string | null;
  volume_name: string;
  username: string;
  database_name: string;
  password_enc: Buffer | null;
  internal_port: number;
  exposed_port: number | null;
  memory_limit_mb: number | null;
  cpu_limit: number | null;
  failure_message: string | null;
  created_at: number;
  updated_at: number;
  last_started_at: number | null;
}

/** DTO ที่ปลอดภัยส่งออก API — ไม่มีรหัสผ่าน */
export interface ServiceDto {
  id: string;
  name: string;
  type: ServiceType;
  version: string;
  image: string;
  status: ServiceStatus;
  username: string;
  databaseName: string;
  internalPort: number;
  exposedPort: number | null;
  memoryLimitMb: number | null;
  cpuLimit: number | null;
  failureMessage: string | null;
  createdAt: number;
  updatedAt: number;
  lastStartedAt: number | null;
}

const SELECT_ALL = `
  id, name, type, version, image, status, container_id, volume_name,
  username, database_name, password_enc, internal_port, exposed_port,
  memory_limit_mb, cpu_limit, failure_message, created_at, updated_at, last_started_at
`;

export function toDto(row: ServiceRow): ServiceDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type as ServiceType,
    version: row.version,
    image: row.image,
    status: row.status as ServiceStatus,
    username: row.username,
    databaseName: row.database_name,
    internalPort: row.internal_port,
    exposedPort: row.exposed_port,
    memoryLimitMb: row.memory_limit_mb,
    cpuLimit: row.cpu_limit,
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastStartedAt: row.last_started_at,
  };
}

function aad(serviceId: string): string {
  return `service:${serviceId}:password`;
}

// ---------------------------------------------------------------------------
// Credential generation
// ---------------------------------------------------------------------------

/**
 * รหัสผ่านสุ่มจาก CSPRNG — ไม่มีอักขระที่ต้อง escape ใน URI/shell/YAML
 *
 * ตัดอักขระพิเศษออกทั้งหมดโดยตั้งใจ: ผู้ใช้ต้อง copy connection string ไปวางใน
 * .env, docker-compose, connection dialog ฯลฯ ซึ่งแต่ละที่ escape ไม่เหมือนกัน
 * ความยาว 30 ตัวจาก alphabet 62 ตัว ให้ ~178 bit เกินพอชดเชยที่ตัด charset ลง
 */
export function generatePassword(length = SERVICE_SETTINGS.passwordLength): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) {
    // modulo bias เล็กน้อย (256 % 62 = 8) ยอมรับได้ที่ entropy ระดับนี้
    out += alphabet[(bytes[i] as number) % alphabet.length];
  }
  return out;
}

/**
 * ชื่อ user/database ที่ปลอดภัยกับ database ทุกชนิด
 *
 * PostgreSQL/MySQL identifier ต้องขึ้นต้นด้วยตัวอักษร และห้ามมี hyphen ถ้าไม่ quote
 * — ดึงเฉพาะ [a-z0-9_] จากชื่อที่ผู้ใช้ตั้ง แล้วเติม prefix กันขึ้นต้นด้วยตัวเลข
 */
export function safeIdentifier(displayName: string, fallback = "app"): string {
  const cleaned = displayName
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 30);
  if (!cleaned || /^\d/.test(cleaned)) return `${fallback}_${cleaned || "db"}`.slice(0, 30);
  return cleaned;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function listServices(db: Database): ServiceDto[] {
  return db
    .query<ServiceRow, []>(`SELECT ${SELECT_ALL} FROM services ORDER BY created_at DESC`)
    .all()
    .map(toDto);
}

export function getServiceRow(db: Database, id: string): ServiceRow | null {
  return (
    db.query<ServiceRow, [string]>(`SELECT ${SELECT_ALL} FROM services WHERE id = ?`).get(id) ??
    null
  );
}

export function requireService(db: Database, id: string): ServiceRow {
  const row = getServiceRow(db, id);
  if (!row) throw new AppError("SERVICE_NOT_FOUND", "ไม่พบ service นี้");
  return row;
}

/** ถอดรหัสรหัสผ่าน — เรียกเฉพาะตอนผู้ใช้ขอดู credentials โดยตั้งใจเท่านั้น */
export async function decryptPassword(
  masterKeys: MasterKeys | null,
  row: ServiceRow,
): Promise<string> {
  if (!row.password_enc) return "";
  if (!masterKeys) {
    throw new AppError("ENV_ENCRYPTION_NOT_CONFIGURED", "ยังไม่ได้ตั้งค่า master key");
  }
  return decryptEnvelope(masterKeys, new Uint8Array(row.password_enc), aad(row.id));
}

export function credentialsOf(row: ServiceRow, password: string): ServiceCredentials {
  return { username: row.username, password, database: row.database_name };
}

// ---------------------------------------------------------------------------
// Port validation
// ---------------------------------------------------------------------------

/**
 * ตรวจ port ที่ขอเปิดออก host
 *
 * ตรวจสามชั้น: ช่วงที่อนุญาต → port ที่ระบบใช้เอง → ชนกับ service อื่น
 * (unique index บน exposed_port กันชั้นสุดท้ายใน DB อีกที เผื่อ race)
 */
export function assertExposedPortUsable(
  db: Database,
  port: number,
  excludeServiceId?: string,
): void {
  if (port < SERVICE_SETTINGS.exposedPortMin || port > SERVICE_SETTINGS.exposedPortMax) {
    throw new AppError(
      "SERVICE_PORT_OUT_OF_RANGE",
      `port ต้องอยู่ระหว่าง ${SERVICE_SETTINGS.exposedPortMin}-${SERVICE_SETTINGS.exposedPortMax}`,
    );
  }
  if (SERVICE_SETTINGS.reservedPorts.includes(port)) {
    throw new AppError("SERVICE_PORT_RESERVED", `port ${port} ถูกระบบใช้อยู่ — เลือก port อื่น`);
  }

  const conflict = db
    .query<{ id: string; name: string }, [number]>(
      "SELECT id, name FROM services WHERE exposed_port = ?",
    )
    .get(port);
  if (conflict && conflict.id !== excludeServiceId) {
    throw new AppError("SERVICE_PORT_IN_USE", `port ${port} ถูกใช้โดย service "${conflict.name}"`);
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateServiceInput {
  name: string;
  type: ServiceType;
  version?: string | null;
  exposedPort?: number | null;
  memoryLimitMb?: number | null;
  cpuLimit?: number | null;
}

export async function createService(
  db: Database,
  masterKeys: MasterKeys | null,
  input: CreateServiceInput,
): Promise<ServiceDto> {
  if (!masterKeys) {
    throw new AppError(
      "ENV_ENCRYPTION_NOT_CONFIGURED",
      "ยังไม่ได้ตั้งค่า master key — ตั้งค่าก่อนจึงจะสร้าง database ได้",
    );
  }

  const name = input.name.trim();
  if (!name) throw new AppError("VALIDATION_ERROR", "ต้องระบุชื่อ service");

  let version: string;
  try {
    version = resolveVersion(input.type, input.version);
  } catch (err) {
    throw new AppError(
      "SERVICE_VERSION_INVALID",
      err instanceof Error ? err.message : "version ไม่ถูกต้อง",
    );
  }

  if (input.exposedPort != null) assertExposedPortUsable(db, input.exposedPort);

  const template = getTemplate(input.type);
  const id = ulid();
  const now = Date.now();

  const identifier = safeIdentifier(name);
  const password = generatePassword();
  const ciphertext = await encryptEnvelope(masterKeys, password, aad(id));

  try {
    db.query(
      `INSERT INTO services
         (id, name, type, version, image, status, volume_name,
          username, database_name, password_enc,
          internal_port, exposed_port, memory_limit_mb, cpu_limit,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      input.type,
      version,
      serviceImage(input.type, version),
      serviceVolumeName(id),
      identifier,
      identifier,
      ciphertext,
      template.internalPort,
      input.exposedPort ?? null,
      input.memoryLimitMb ?? SERVICE_SETTINGS.defaultMemoryMb,
      input.cpuLimit ?? null,
      now,
      now,
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      // exposed_port ถูกตรวจไปแล้วด้านบน — UNIQUE ที่ชนตรงนี้จึงเป็น name เกือบเสมอ
      // (ยกเว้น race ที่สอง request สร้าง port เดียวกันพร้อมกัน ซึ่ง DB กันให้)
      if (err.message.includes("exposed_port")) {
        throw new AppError("SERVICE_PORT_IN_USE", `port ${input.exposedPort} ถูกใช้ไปแล้ว`);
      }
      throw new AppError("SERVICE_DUPLICATE_NAME", `ชื่อ "${name}" ถูกใช้แล้ว`);
    }
    throw err;
  }

  return toDto(requireService(db, id));
}

// ---------------------------------------------------------------------------
// Update / status
// ---------------------------------------------------------------------------

export interface UpdateServiceInput {
  name?: string;
  exposedPort?: number | null;
  memoryLimitMb?: number | null;
  cpuLimit?: number | null;
}

/**
 * แก้ config ได้เฉพาะตอน stopped — เปลี่ยน port/memory ระหว่างรันไม่มีผลจนกว่าจะ recreate
 * container ปล่อยให้แก้ได้จะทำให้ UI แสดงค่าที่ไม่ตรงกับของจริง
 */
export function updateService(db: Database, id: string, input: UpdateServiceInput): ServiceDto {
  const row = requireService(db, id);

  const changesRuntime =
    input.exposedPort !== undefined ||
    input.memoryLimitMb !== undefined ||
    input.cpuLimit !== undefined;

  if (changesRuntime && row.status !== "stopped" && row.status !== "failed") {
    throw new AppError(
      "SERVICE_NOT_STOPPED",
      "ต้องหยุด service ก่อนจึงจะแก้ port หรือ resource limit ได้",
    );
  }

  if (input.exposedPort != null) assertExposedPortUsable(db, input.exposedPort, id);

  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  const set = (col: string, val: string | number | null) => {
    fields.push(`${col} = ?`);
    values.push(val);
  };

  if (input.name !== undefined) set("name", input.name.trim());
  if (input.exposedPort !== undefined) set("exposed_port", input.exposedPort);
  if (input.memoryLimitMb !== undefined) set("memory_limit_mb", input.memoryLimitMb);
  if (input.cpuLimit !== undefined) set("cpu_limit", input.cpuLimit);

  if (fields.length > 0) {
    set("updated_at", Date.now());
    values.push(id);
    try {
      db.query(`UPDATE services SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE")) {
        if (err.message.includes("exposed_port")) {
          throw new AppError("SERVICE_PORT_IN_USE", "port นี้ถูกใช้ไปแล้ว");
        }
        throw new AppError("SERVICE_DUPLICATE_NAME", "ชื่อนี้ถูกใช้แล้ว");
      }
      throw err;
    }
  }

  return toDto(requireService(db, id));
}

export function deleteServiceRow(db: Database, id: string): void {
  db.query("DELETE FROM services WHERE id = ?").run(id);
}
