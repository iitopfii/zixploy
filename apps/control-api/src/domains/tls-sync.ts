/**
 * Sync custom certificates จาก DB → disk ให้ Traefik — docs/phase-05-domains.md M5
 *
 * เชื่อม tls-store (decrypt) กับ tls-materialize (เขียนไฟล์) เข้าด้วยกัน แล้วให้ caller
 * เรียกจุดเดียวหลังทุกการเปลี่ยนแปลงที่กระทบ cert:
 *   - อัปโหลด/ลบ certificate
 *   - enable/disable domain (disabled domain ต้องไม่เหลือ cert ให้ Traefik serve)
 *   - ลบ domain
 *   - startup ของ control-api (กู้สถานะหลัง volume ถูก restore จาก backup หรือ container ใหม่)
 *
 * เป็น full sync ทุกครั้ง (ไม่ incremental) — ราคาถูกมาก (custom cert มีไม่กี่ใบต่อ server)
 * และทำให้ไม่มีทางที่ disk กับ DB จะ drift กันได้ไม่ว่าจะพลาดเรียกที่จุดไหน
 *
 * Failure policy: sync ล้มเหลว **ไม่** ทำให้ HTTP request ที่เรียกมาล้มตาม — cert ถูกบันทึกลง
 * DB แล้ว (ซึ่งเป็น source of truth) และ sync รอบถัดไปจะแก้ให้เอง การโยน error กลับไปจะทำให้
 * ผู้ใช้เข้าใจว่าอัปโหลดไม่สำเร็จแล้วอัปโหลดซ้ำทั้งที่ข้อมูลเข้าไปแล้ว
 */

import type { Database } from "bun:sqlite";
import type { MasterKeys } from "../crypto/master-key";
import { log } from "../logger";
import { materializeCertificates } from "./tls-materialize";
import { decryptActiveCertificates } from "./tls-store";

export interface SyncResult {
  ok: boolean;
  written: number;
  removed: number;
  /** domain ที่ decrypt ไม่ผ่าน — ไม่ block ใบอื่น แต่ต้องรายงาน */
  failed: Array<{ domainId: string; hostname: string }>;
}

/**
 * เขียน custom certificate ทุกใบที่ active ลง disk แล้ว regenerate Traefik dynamic config
 * ไม่โยน error — คืน ok:false แทน (ดู Failure policy ด้านบน)
 */
export async function syncCertificates(
  db: Database,
  masterKeys: MasterKeys | null,
): Promise<SyncResult> {
  const failed: Array<{ domainId: string; hostname: string }> = [];

  try {
    const certs = await decryptActiveCertificates(db, masterKeys, (domainId, hostname, message) => {
      failed.push({ domainId, hostname });
      log.error("decrypt custom certificate ไม่สำเร็จ — ข้ามใบนี้", {
        domainId,
        hostname,
        // message มาจาก envelope.ts ซึ่งไม่ใส่เนื้อ ciphertext/key ลง message อยู่แล้ว
        reason: message,
      });
    });

    const result = materializeCertificates(certs);
    log.info("sync custom certificates สำเร็จ", {
      written: result.written,
      removed: result.removed.length,
      failed: failed.length,
    });
    return { ok: true, written: result.written, removed: result.removed.length, failed };
  } catch (err) {
    log.error("sync custom certificates ล้มเหลว — DB ยังถูกต้อง sync รอบหน้าจะแก้ให้", {
      reason: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, written: 0, removed: 0, failed };
  }
}
