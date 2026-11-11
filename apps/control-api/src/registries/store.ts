/**
 * Container registry credentials — ใช้ pull image private ของ compose component (0.1.24)
 *
 * password เก็บเป็น envelope (AES-256-GCM, AAD "registry:<id>") — ห้ามคืน plaintext ออก API
 * worker ถอดรหัสเองตอน pull (apps/deploy-worker/src/registries/auth.ts) แล้วเขียน DOCKER_CONFIG ชั่วคราว
 */

import type { Database } from "bun:sqlite";
import { AppError, ulid } from "@zixploy/shared";
import { encryptEnvelope } from "../crypto/envelope";
import type { MasterKeys } from "../crypto/master-key";

interface RegistryRow {
  id: string;
  registry: string;
  username: string;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface RegistryDto {
  id: string;
  registry: string;
  username: string;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** AAD ผูก ciphertext กับแถว — ย้าย blob ไปแถวอื่นแล้วถอดไม่ได้ (worker ใช้ค่าเดียวกัน) */
export function registryAad(id: string): string {
  return `registry:${id}`;
}

// ไม่ SELECT password_ciphertext โดยตั้งใจ — DTO ไหลออก HTTP
const SELECT_PUBLIC = "id, registry, username, last_used_at, created_at, updated_at";

function toDto(row: RegistryRow): RegistryDto {
  return {
    id: row.id,
    registry: row.registry,
    username: row.username,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listRegistries(db: Database): RegistryDto[] {
  return db
    .query<RegistryRow, []>(`SELECT ${SELECT_PUBLIC} FROM registry_credentials ORDER BY registry`)
    .all()
    .map(toDto);
}

export function getRegistry(db: Database, id: string): RegistryDto {
  const row = db
    .query<RegistryRow, [string]>(`SELECT ${SELECT_PUBLIC} FROM registry_credentials WHERE id = ?`)
    .get(id);
  if (!row) throw new AppError("REGISTRY_NOT_FOUND", "ไม่พบ registry นี้");
  return toDto(row);
}

export async function createRegistry(
  db: Database,
  masterKeys: MasterKeys,
  input: { registry: string; username: string; password: string },
): Promise<RegistryDto> {
  const id = ulid();
  const now = Date.now();
  const ciphertext = await encryptEnvelope(masterKeys, input.password, registryAad(id));
  try {
    db.query(
      `INSERT INTO registry_credentials (id, registry, username, password_ciphertext, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.registry, input.username, ciphertext, now, now);
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      throw new AppError(
        "REGISTRY_DUPLICATE",
        `มี credential ของ ${input.registry} อยู่แล้ว — แก้ไขแถวเดิมแทน`,
      );
    }
    throw err;
  }
  return getRegistry(db, id);
}

export async function updateRegistry(
  db: Database,
  masterKeys: MasterKeys,
  id: string,
  input: { username?: string; password?: string },
): Promise<RegistryDto> {
  getRegistry(db, id);
  const now = Date.now();
  if (input.username !== undefined) {
    db.query("UPDATE registry_credentials SET username = ?, updated_at = ? WHERE id = ?").run(
      input.username,
      now,
      id,
    );
  }
  if (input.password !== undefined) {
    const ciphertext = await encryptEnvelope(masterKeys, input.password, registryAad(id));
    db.query(
      "UPDATE registry_credentials SET password_ciphertext = ?, updated_at = ? WHERE id = ?",
    ).run(ciphertext, now, id);
  }
  return getRegistry(db, id);
}

export function deleteRegistry(db: Database, id: string): void {
  getRegistry(db, id);
  db.query("DELETE FROM registry_credentials WHERE id = ?").run(id);
}
