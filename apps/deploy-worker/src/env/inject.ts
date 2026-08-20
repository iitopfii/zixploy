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
 * masterKeys null / decrypt ล้มเหลว → key นั้นถูกข้าม แต่รายงานผ่าน definedCount + failedKeys เสมอ
 * — ตัว pipeline เป็นคนตัดสินใจ fail-loud เมื่อ "ตั้ง env ไว้แต่ฉีดเข้าไม่ได้เลยสักตัว"
 * (เดิมคืน empty เงียบ ๆ ทำให้ container รันไร้ config โดยไม่มีใครรู้จนแอป crash)
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
  /**
   * จำนวน env ที่ enabled อยู่ใน scope นี้ตาม DB (ไม่ใช่จำนวนที่ฉีดสำเร็จ) — pipeline ใช้เทียบกับ
   * failedKeys เพื่อจับเคส "ตั้ง env ไว้แต่ไม่ได้อะไรเลย" ที่เคยผ่านเงียบ ๆ จน container รันไร้ config
   */
  definedCount: number;
  /** key ที่ decrypt ไม่สำเร็จ (ถูกข้าม) — หรือทุก key เมื่อไม่มี master key เลย */
  failedKeys: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function aad(projectId: string, key: string): string {
  return `env:${projectId}:${key}`;
}

/** สร้าง object ใหม่ทุกครั้ง (ไม่ใช่ const ร่วม) — failedKeys เป็น array ที่ต้องไม่ leak ข้าม call */
function emptyInjection(definedCount = 0, failedKeys: string[] = []): EnvInjection {
  return {
    runtimeEnv: {},
    buildArgs: {},
    buildSecretValues: [],
    secretValues: [],
    definedCount,
    failedKeys,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** decrypt + split ตาม scope จาก rows ที่โหลดมาแล้ว (graceful: row ที่ decrypt ไม่ได้ → skip + log) */
async function decryptAndSplit(
  masterKeys: MasterKeys,
  projectId: string,
  rows: EnvVarRow[],
  onLog: (line: string) => void,
): Promise<EnvInjection> {
  const runtimeEnv: Record<string, string> = {};
  const buildArgs: Record<string, string> = {};
  const buildSecretValues: Array<{ key: string; value: string }> = [];
  const secretValues: string[] = [];
  const failedKeys: string[] = [];

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
      failedKeys.push(row.key);
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

  return {
    runtimeEnv,
    buildArgs,
    buildSecretValues,
    secretValues,
    definedCount: rows.length,
    failedKeys,
  };
}

/** ไม่มี master key แต่มี env ตั้งไว้ — รายงานทุก key เป็น failed (pipeline ตัดสินใจ fail-loud เอง) */
function missingKeysInjection(rows: EnvVarRow[], onLog: (line: string) => void): EnvInjection {
  const keys = rows.map((r) => r.key);
  onLog(
    `[env] ⚠️ ไม่มี master key — env ${rows.length} ตัวจะไม่ถูกฉีดเข้า deployment (${keys.join(", ")})`,
  );
  return emptyInjection(rows.length, keys);
}

/**
 * Load + decrypt env vars ระดับ project (component_id IS NULL) แล้ว split ตาม scope
 *
 * ใช้โดย single-container pipeline และเป็น "ฐาน" ของ compose (แต่ละ component override ทับด้วย
 * injectComponentEnv) — กรอง component_id IS NULL สำคัญ: หลังมี component-scoped env แล้ว ถ้าไม่กรอง
 * env ของ component หนึ่งจะรั่วไปทุก container
 *
 * graceful: masterKeys=null หรือ decrypt ไม่ได้ → skip + log แทน throw
 */
export async function injectEnvVars(
  db: Database,
  masterKeys: MasterKeys | null,
  projectId: string,
  onLog: (line: string) => void,
): Promise<EnvInjection> {
  const rows = db
    .query<EnvVarRow, [string]>(
      "SELECT key, value_ciphertext, is_secret, scope FROM environment_variables WHERE project_id = ? AND enabled = 1 AND component_id IS NULL",
    )
    .all(projectId);
  if (rows.length === 0) return emptyInjection();
  // query ก่อนค่อยเช็ค masterKeys — ต้องรู้ว่ามี env ตั้งไว้กี่ตัวแม้ไม่มี key เพื่อให้ pipeline
  // fail-loud ได้ (เดิมคืน empty เงียบ ๆ → container รันไร้ config โดยไม่มีใครรู้)
  if (!masterKeys) return missingKeysInjection(rows, onLog);
  return decryptAndSplit(masterKeys, projectId, rows, onLog);
}

/**
 * Load + decrypt env vars ที่ผูกกับ component หนึ่งตัว (component_id = ?) — Phase 18 · F
 * orchestrator เอามา merge ทับ project-wide env ของ component นั้น (component override project)
 */
export async function injectComponentEnv(
  db: Database,
  masterKeys: MasterKeys | null,
  projectId: string,
  componentId: string,
  onLog: (line: string) => void,
): Promise<EnvInjection> {
  const rows = db
    .query<EnvVarRow, [string, string]>(
      "SELECT key, value_ciphertext, is_secret, scope FROM environment_variables WHERE project_id = ? AND component_id = ? AND enabled = 1",
    )
    .all(projectId, componentId);
  if (rows.length === 0) return emptyInjection();
  if (!masterKeys) return missingKeysInjection(rows, onLog);
  return decryptAndSplit(masterKeys, projectId, rows, onLog);
}
