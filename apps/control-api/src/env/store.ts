/**
 * Environment variable storage — encrypt, persist, list (docs/phase-04-environment.md)
 *
 * ทุกค่าเข้ารหัสด้วย AES-256-GCM (docs/encryption.md) ก่อน persist เสมอ
 * AAD: "env:<project_id>:<key>" — ย้าย ciphertext ข้าม project หรือ rename key ไม่ได้
 *
 * API response ไม่คืน plaintext เด็ดขาด — คืนแค่ metadata (hasValue: true)
 * decryptForWorker() เปิดให้เฉพาะ worker ผ่าน DB โดยตรง (ไม่ผ่าน HTTP)
 */

import type { Database } from "bun:sqlite";
import { AppError, ENV_VAR_KEY_RE, ulid } from "@zixploy/shared";
import { decryptEnvelope, encryptEnvelope } from "../crypto/envelope";
import type { MasterKeys } from "../crypto/master-key";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EnvVarRow {
  id: string;
  project_id: string;
  key: string;
  value_ciphertext: Buffer; // bun:sqlite returns BLOB as Buffer
  is_secret: number;
  scope: string;
  enabled: number;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface EnvVarSummary {
  id: string;
  key: string;
  isSecret: boolean;
  /** always true — API ไม่คืน plaintext เด็ดขาด */
  hasValue: true;
  scope: "runtime" | "build" | "both";
  enabled: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface EnvVarInput {
  key: string;
  value: string;
  isSecret?: boolean;
  scope?: "runtime" | "build" | "both";
  enabled?: boolean;
}

/** ข้อมูลที่ worker ใช้ inject เข้า container — ไม่ส่งผ่าน HTTP */
export interface DecryptedEnvVar {
  key: string;
  value: string;
  isSecret: boolean;
  scope: "runtime" | "build" | "both";
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SELECT_COLS = `id, project_id, key, value_ciphertext, is_secret, scope, enabled, version, created_at, updated_at`;

function aad(projectId: string, key: string): string {
  return `env:${projectId}:${key}`;
}

function toSummary(row: EnvVarRow): EnvVarSummary {
  return {
    id: row.id,
    key: row.key,
    isSecret: row.is_secret === 1,
    hasValue: true,
    scope: row.scope as "runtime" | "build" | "both",
    enabled: row.enabled === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateKeys(vars: EnvVarInput[]): void {
  const seen = new Set<string>();
  for (const v of vars) {
    if (!ENV_VAR_KEY_RE.test(v.key)) {
      throw new AppError(
        "ENV_VAR_INVALID_KEY",
        `key "${v.key}" ไม่ถูกต้อง — ต้องขึ้นต้นด้วยตัวอักษรหรือ underscore และมีเฉพาะ [A-Za-z0-9_]`,
        { key: v.key },
      );
    }
    if (seen.has(v.key)) {
      throw new AppError("ENV_VAR_DUPLICATE_KEY", `key "${v.key}" ซ้ำกันในรายการที่ส่งมา`, {
        key: v.key,
      });
    }
    seen.add(v.key);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** list metadata — ไม่ decrypt ไม่คืน plaintext */
export function listEnvVars(db: Database, projectId: string): EnvVarSummary[] {
  return db
    .query<EnvVarRow, [string]>(
      `SELECT ${SELECT_COLS} FROM environment_variables WHERE project_id = ? ORDER BY key`,
    )
    .all(projectId)
    .map(toSummary);
}

/**
 * Replace ชุด env vars ของ project ทั้งหมดในคราวเดียว (full replace in one transaction)
 * masterKeys จำเป็น — throw ENV_ENCRYPTION_NOT_CONFIGURED ถ้า null
 */
export async function replaceEnvVars(
  db: Database,
  projectId: string,
  vars: EnvVarInput[],
  masterKeys: MasterKeys,
): Promise<EnvVarSummary[]> {
  validateKeys(vars);

  const now = Date.now();

  // เข้ารหัสทุกค่าก่อน (async) — ทำนอก transaction เพราะ WebCrypto เป็น async
  const encrypted = await Promise.all(
    vars.map(async (v) => ({
      id: ulid(),
      key: v.key,
      ciphertext: await encryptEnvelope(masterKeys, v.value, aad(projectId, v.key)),
      isSecret: v.isSecret ?? false,
      scope: v.scope ?? "runtime",
      enabled: v.enabled ?? true,
    })),
  );

  // transaction: delete all → insert new — atomic full replace
  db.transaction(() => {
    db.query("DELETE FROM environment_variables WHERE project_id = ?").run(projectId);
    const stmt = db.prepare(
      `INSERT INTO environment_variables
         (id, project_id, key, value_ciphertext, is_secret, scope, enabled, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    for (const v of encrypted) {
      stmt.run(
        v.id,
        projectId,
        v.key,
        v.ciphertext,
        v.isSecret ? 1 : 0,
        v.scope,
        v.enabled ? 1 : 0,
        now,
        now,
      );
    }
  })();

  return listEnvVars(db, projectId);
}

/**
 * Decrypt all enabled env vars for a project — ใช้โดย worker (ไม่ใช้ผ่าน HTTP)
 * masterKeys null → คืน [] พร้อม log warning (ไม่ throw — deploy ยังสำเร็จได้แต่ไม่มี env)
 */
export async function decryptEnvVarsForWorker(
  db: Database,
  projectId: string,
  masterKeys: MasterKeys,
): Promise<DecryptedEnvVar[]> {
  const rows = db
    .query<EnvVarRow, [string]>(
      `SELECT ${SELECT_COLS} FROM environment_variables WHERE project_id = ? AND enabled = 1`,
    )
    .all(projectId);

  return Promise.all(
    rows.map(async (row) => ({
      key: row.key,
      value: await decryptEnvelope(
        masterKeys,
        new Uint8Array(row.value_ciphertext),
        aad(projectId, row.key),
      ),
      isSecret: row.is_secret === 1,
      scope: row.scope as "runtime" | "build" | "both",
      enabled: true,
    })),
  );
}
