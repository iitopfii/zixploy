/**
 * Key rotation logic สำหรับ environment_variables — docs/phase-04-environment.md M5
 *
 * Re-encrypt ทุกแถวใน environment_variables ที่ยังไม่ได้ใช้ active key ปัจจุบัน
 * โดยอ่าน key_id จาก envelope header (byte 1) — ไม่ต้องเก็บ key_id ใน DB แยก
 *
 * ขั้นตอน:
 *   1. อ่านทุกแถวจาก environment_variables
 *   2. อ่าน key_id จาก envelope (byte 1 — docs/encryption.md)
 *   3. key_id === active → skip (ใช้ active key อยู่แล้ว)
 *   4. decrypt ด้วย key ที่ระบุใน envelope, re-encrypt ด้วย active key ใหม่
 *   5. UPDATE ใน batch transaction ทีละ batchSize แถว (default 50)
 *
 * Idempotent: รันซ้ำได้ปลอดภัย — แถวที่ rotate แล้วจะถูก skip ทันที
 *
 * ห้าม import จาก deploy-worker — นี่คือ control-api logic เท่านั้น
 */

import type { Database } from "bun:sqlite";
import { decryptEnvelope, encryptEnvelope } from "../crypto/envelope";
import type { MasterKeys } from "../crypto/master-key";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EnvVarRowFull {
  id: string;
  project_id: string;
  key: string;
  value_ciphertext: Buffer;
  version: number;
}

export interface RotationResult {
  total: number;
  rotated: number;
  skipped: number;
  failed: number;
}

export interface RotateOptions {
  /** จำนวนแถวต่อ transaction (default 50) */
  batchSize?: number;
  /** progress callback (CLI ส่ง console.log, test ส่ง array collector) */
  onProgress?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function aad(projectId: string, key: string): string {
  return `env:${projectId}:${key}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Re-encrypt ทุก environment_variables ที่ยังไม่ได้ใช้ active key ปัจจุบัน
 *
 * @param db - Database instance (เปิดด้วย openDatabase แล้ว)
 * @param masterKeys - ต้องมีทั้ง old keys (สำหรับ decrypt) และ active key ใหม่ (สำหรับ encrypt)
 * @param opts - batchSize และ onProgress
 * @returns ผลสรุป total/rotated/skipped/failed
 */
export async function rotateEnvVarKeys(
  db: Database,
  masterKeys: MasterKeys,
  opts: RotateOptions = {},
): Promise<RotationResult> {
  const { batchSize = 50, onProgress } = opts;
  const log = onProgress ?? (() => {});

  const rows = db
    .query<EnvVarRowFull, []>(
      "SELECT id, project_id, key, value_ciphertext, version FROM environment_variables",
    )
    .all();

  const total = rows.length;
  let rotated = 0;
  let skipped = 0;
  let failed = 0;

  log(`พบ ${total} แถวใน environment_variables`);
  if (total === 0) return { total, rotated, skipped, failed };

  const totalBatches = Math.ceil(rows.length / batchSize);

  for (let batchStart = 0; batchStart < rows.length; batchStart += batchSize) {
    const batch = rows.slice(batchStart, batchStart + batchSize);
    const batchNum = Math.floor(batchStart / batchSize) + 1;

    let batchRotated = 0;
    let batchSkipped = 0;
    let batchFailed = 0;

    // เตรียม update list ก่อน (async operations ทำนอก transaction)
    const updates: Array<{ id: string; ciphertext: Uint8Array; version: number }> = [];

    for (const row of batch) {
      const envelopeBytes = new Uint8Array(row.value_ciphertext);

      // envelope format (docs/encryption.md):
      //   byte 0 = version (0x01)
      //   byte 1 = key_id (master key id ที่ใช้เข้ารหัส)
      //   bytes 2-13 = nonce
      //   bytes 14+ = ciphertext + 16-byte GCM tag
      const keyId = envelopeBytes[1];

      if (keyId === masterKeys.active) {
        batchSkipped++;
        skipped++;
        continue; // ใช้ active key อยู่แล้ว — ไม่ต้อง rotate
      }

      // Decrypt ด้วย key เดิม (ระบุโดย key_id ใน envelope)
      let plaintext: string;
      try {
        plaintext = await decryptEnvelope(masterKeys, envelopeBytes, aad(row.project_id, row.key));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  ⚠ ข้าม "${row.key}" (id=${row.id}): decrypt ไม่สำเร็จ — ${msg}`);
        batchFailed++;
        failed++;
        continue;
      }

      // Re-encrypt ด้วย active key ใหม่
      let newCiphertext: Uint8Array;
      try {
        newCiphertext = await encryptEnvelope(masterKeys, plaintext, aad(row.project_id, row.key));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  ⚠ ข้าม "${row.key}" (id=${row.id}): encrypt ใหม่ไม่สำเร็จ — ${msg}`);
        batchFailed++;
        failed++;
        continue;
      }

      updates.push({ id: row.id, ciphertext: newCiphertext, version: row.version + 1 });
    }

    // Commit batch ใน single transaction
    if (updates.length > 0) {
      const now = Date.now();
      db.transaction(() => {
        const stmt = db.prepare(
          "UPDATE environment_variables SET value_ciphertext = ?, version = ?, updated_at = ? WHERE id = ?",
        );
        for (const u of updates) {
          stmt.run(u.ciphertext, u.version, now, u.id);
        }
      })();
      batchRotated = updates.length;
      rotated += batchRotated;
    }

    log(
      `  batch ${batchNum}/${totalBatches}: rotated=${batchRotated}, skipped=${batchSkipped}, failed=${batchFailed}`,
    );
  }

  log(`เสร็จสิ้น: total=${total} rotated=${rotated} skipped=${skipped} failed=${failed}`);
  return { total, rotated, skipped, failed };
}
