/**
 * Environment variable injection — docs/phase-04-environment.md M3
 *
 * Decrypt env vars from DB (using worker's own crypto copies — ADR-0002 forbids
 * importing from control-api) and split by scope for the build pipeline:
 *
 *   scope=runtime|both  → runtimeEnv  (docker create -e KEY=VALUE)
 *   scope=build|both    → buildArgs   (--build-arg KEY=VALUE, non-secret only)
 *   scope=build|both    → buildSecretValues  (--secret id=KEY,src=<file>, secret only)
 *
 * masterKeys null → returns empty injection (graceful — deploy continues without env vars;
 * operator must configure ZIXPLOY_MASTER_KEY_FILE if env vars are needed)
 *
 * AAD ตรงกับ control-api: "env:<project_id>:<key>" (encryption.md)
 *
 * ห้าม import จาก apps/control-api — worker ใช้ crypto ที่ duplicate ไว้ใน src/github/
 */

import type { Database } from "bun:sqlite";
import { decryptEnvelope } from "../github/envelope";
import type { MasterKeys } from "../github/master-key";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EnvVarRow {
  key: string;
  value_ciphertext: Buffer;
  is_secret: number;
  scope: string;
}

export interface EnvInjection {
  /** docker create -e KEY=VALUE — scope runtime|both */
  runtimeEnv: Record<string, string>;
  /** --build-arg KEY=VALUE — scope build|both AND is_secret=false */
  buildArgs: Record<string, string>;
  /** --secret id=KEY,src=<tmpfile> — scope build|both AND is_secret=true */
  buildSecretValues: Array<{ key: string; value: string }>;
  /** ค่าของ is_secret=true ทุกตัว (ไม่คำนึงถึง scope) — สำหรับ redaction set (M4) */
  secretValues: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function aad(projectId: string, key: string): string {
  return `env:${projectId}:${key}`;
}

const EMPTY_INJECTION: EnvInjection = {
  runtimeEnv: {},
  buildArgs: {},
  buildSecretValues: [],
  secretValues: [],
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and decrypt all enabled env vars for a project, then split by scope.
 *
 * ออกแบบให้ graceful: masterKeys=null หรือ row ที่ decrypt ไม่ได้ → skip + log แทน throw
 * เพื่อให้ deploy ดำเนินต่อได้แม้ key rotation ยังทำไม่เสร็จ หรือ operator ไม่ได้ตั้ง key
 */
export async function injectEnvVars(
  db: Database,
  masterKeys: MasterKeys | null,
  projectId: string,
  onLog: (line: string) => void,
): Promise<EnvInjection> {
  if (!masterKeys) {
    // ไม่มี master key — ไม่มี env injection ไม่ throw (ops choice)
    return EMPTY_INJECTION;
  }

  const rows = db
    .query<EnvVarRow, [string]>(
      "SELECT key, value_ciphertext, is_secret, scope FROM environment_variables WHERE project_id = ? AND enabled = 1",
    )
    .all(projectId);

  if (rows.length === 0) return EMPTY_INJECTION;

  const runtimeEnv: Record<string, string> = {};
  const buildArgs: Record<string, string> = {};
  const buildSecretValues: Array<{ key: string; value: string }> = [];
  const secretValues: string[] = [];

  for (const row of rows) {
    let value: string;
    try {
      value = await decryptEnvelope(
        masterKeys,
        new Uint8Array(row.value_ciphertext),
        aad(projectId, row.key),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onLog(`[env] ข้าม key "${row.key}": decrypt ไม่สำเร็จ — ${msg}`);
      continue;
    }

    const isSecret = row.is_secret === 1;
    const scope = row.scope as "runtime" | "build" | "both";

    if (isSecret) secretValues.push(value);

    if (scope === "runtime" || scope === "both") {
      runtimeEnv[row.key] = value;
    }
    if (scope === "build" || scope === "both") {
      if (isSecret) {
        // secret → --secret (ห้ามใช้ --build-arg ตาม threat-model.md)
        buildSecretValues.push({ key: row.key, value });
      } else {
        // non-secret → --build-arg ได้ปลอดภัย
        buildArgs[row.key] = value;
      }
    }
  }

  return { runtimeEnv, buildArgs, buildSecretValues, secretValues };
}
