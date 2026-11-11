/**
 * โหลด credential ของ registry สำหรับ image ref หนึ่งตัว (0.1.24)
 *
 * worker อ่าน registry_credentials จาก DB เอง (ADR-0002) แล้วถอดรหัสด้วย master key ชุดเดียวกับ env
 * AAD "registry:<id>" ต้องตรงกับฝั่งเขียน (apps/control-api/src/registries/store.ts)
 */

import type { Database } from "bun:sqlite";
import { AppError, imageRegistry } from "@zixploy/shared";
import type { RegistryAuth } from "../docker/cli-client";
import { decryptEnvelope } from "../github/envelope";
import type { MasterKeys } from "../github/master-key";

interface CredentialRow {
  id: string;
  registry: string;
  username: string;
  password_ciphertext: Buffer;
}

export interface LoadedRegistryAuth extends RegistryAuth {
  id: string;
}

/**
 * credential ของ registry ที่ image ref นี้อยู่ — ไม่มีแถว = null (pull แบบไม่ login เหมือนเดิม)
 *
 * มีแถวแต่ถอดรหัสไม่ได้ = โยน error แทนการ pull แบบไม่ login เงียบ ๆ — image private จะได้ error
 * "unauthorized" ที่ชี้ผิดที่ ส่วน image public จะ pull ผ่านโดยที่ผู้ใช้ไม่รู้ว่า credential เสียแล้ว
 */
export async function loadRegistryAuth(
  db: Database,
  masterKeys: MasterKeys | null,
  imageRef: string,
): Promise<LoadedRegistryAuth | null> {
  const registry = imageRegistry(imageRef);
  const row = db
    .query<CredentialRow, [string]>(
      "SELECT id, registry, username, password_ciphertext FROM registry_credentials WHERE registry = ?",
    )
    .get(registry);
  if (!row) return null;
  if (!masterKeys) {
    throw new AppError(
      "SERVICE_PROVISION_FAILED",
      `มี credential ของ ${registry} แต่ worker ไม่มี master key — ตั้ง ZIXPLOY_MASTER_KEY_FILE ให้ deploy-worker`,
    );
  }
  let password: string;
  try {
    password = await decryptEnvelope(
      masterKeys,
      new Uint8Array(row.password_ciphertext),
      `registry:${row.id}`,
    );
  } catch {
    throw new AppError(
      "SERVICE_PROVISION_FAILED",
      `ถอดรหัส credential ของ ${registry} ไม่ได้ (master key เปลี่ยน?) — กรอก password ใหม่ที่หน้า Registries`,
    );
  }
  return { id: row.id, registry: row.registry, username: row.username, password };
}

export function markRegistryUsed(db: Database, id: string): void {
  db.query("UPDATE registry_credentials SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
}
