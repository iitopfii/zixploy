/**
 * Custom TLS certificate storage — docs/phase-05-domains.md M5
 *
 * cert และ private key เข้ารหัสด้วย AES-256-GCM ก่อน persist เสมอ (เหมือน environment_variables)
 * AAD: "domain_tls:<domain_id>:cert" / "domain_tls:<domain_id>:key"
 * — ผูก ciphertext กับ domain **และ** field: ย้ายข้าม domain หรือสลับช่อง cert↔key แล้ว decrypt ไม่ได้
 *
 * Security:
 * - API ห้ามคืน plaintext ของ cert หรือ key เด็ดขาด — คืนแค่ metadata (fingerprint/expiry/hostnames)
 *   cert ใบเดียวไม่ใช่ความลับก็จริง แต่ key เป็น และการมี code path เดียว (ไม่คืนอะไรเลย)
 *   ปลอดภัยกว่าการมี branch ที่คืน cert แต่ไม่คืน key แล้วพลาดสลับกัน
 * - decryptForMaterialize() มีไว้เพื่อเขียนไฟล์ให้ Traefik เท่านั้น — ไม่ผูกกับ HTTP handler ใด
 */

import type { Database } from "bun:sqlite";
import {
  AppError,
  type ParsedCertificate,
  type TlsMode,
  validateCertificateBundle,
} from "@zixploy/shared";
import { decryptEnvelope, encryptEnvelope } from "../crypto/envelope";
import type { MasterKeys } from "../crypto/master-key";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TlsRow {
  id: string;
  hostname: string;
  tls_mode: string;
  tls_cert_ciphertext: Buffer | null;
  tls_key_ciphertext: Buffer | null;
  tls_cert_fingerprint: string | null;
  tls_cert_subject: string | null;
  tls_cert_issuer: string | null;
  tls_cert_hostnames: string | null;
  tls_cert_not_before: number | null;
  tls_cert_not_after: number | null;
  tls_cert_uploaded_at: number | null;
}

/** metadata ที่ปลอดภัยจะคืนผ่าน API — ไม่มี PEM ใด ๆ */
export interface TlsCertificateInfo {
  fingerprint: string;
  subject: string;
  issuer: string;
  hostnames: string[];
  notBefore: number;
  notAfter: number;
  uploadedAt: number;
  selfSigned: boolean;
}

/** PEM คู่ที่ decrypt แล้ว — ใช้เขียนไฟล์ให้ Traefik เท่านั้น ห้ามส่งออก HTTP */
export interface DecryptedCertificate {
  domainId: string;
  hostname: string;
  certPem: string;
  keyPem: string;
}

const TLS_COLS = `
  id, hostname, tls_mode,
  tls_cert_ciphertext, tls_key_ciphertext,
  tls_cert_fingerprint, tls_cert_subject, tls_cert_issuer, tls_cert_hostnames,
  tls_cert_not_before, tls_cert_not_after, tls_cert_uploaded_at
`;

function certAad(domainId: string): string {
  return `domain_tls:${domainId}:cert`;
}

function keyAad(domainId: string): string {
  return `domain_tls:${domainId}:key`;
}

function requireMasterKeys(masterKeys: MasterKeys | null): MasterKeys {
  if (!masterKeys) {
    throw new AppError(
      "TLS_ENCRYPTION_NOT_CONFIGURED",
      "ยังไม่ได้ตั้งค่า master key — ตั้ง ZIXPLOY_MASTER_KEY_FILE ก่อนอัปโหลด certificate",
    );
  }
  return masterKeys;
}

function loadRow(db: Database, domainId: string): TlsRow {
  const row = db
    .query<TlsRow, [string]>(`SELECT ${TLS_COLS} FROM project_domains WHERE id = ?`)
    .get(domainId);
  if (!row) throw new AppError("DOMAIN_NOT_FOUND", "ไม่พบ domain นี้");
  return row;
}

/** row → metadata (null ถ้ายังไม่เคยอัปโหลด cert) */
function toInfo(row: TlsRow): TlsCertificateInfo | null {
  if (!row.tls_cert_fingerprint || row.tls_cert_not_after === null) return null;

  let hostnames: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.tls_cert_hostnames ?? "[]");
    if (Array.isArray(parsed)) hostnames = parsed.filter((h): h is string => typeof h === "string");
  } catch {
    // hostnames เสียหายไม่ควรทำให้ทั้ง endpoint พัง — คืน [] แล้วให้ UI แสดง fingerprint ต่อได้
  }

  const subject = row.tls_cert_subject ?? "";
  return {
    fingerprint: row.tls_cert_fingerprint,
    subject,
    issuer: row.tls_cert_issuer ?? "",
    hostnames,
    notBefore: row.tls_cert_not_before ?? 0,
    notAfter: row.tls_cert_not_after,
    uploadedAt: row.tls_cert_uploaded_at ?? 0,
    selfSigned: subject !== "" && subject === row.tls_cert_issuer,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** อ่าน metadata ของ cert ที่อัปโหลดไว้ — null ถ้ายังไม่มี */
export function getCertificateInfo(db: Database, domainId: string): TlsCertificateInfo | null {
  return toInfo(loadRow(db, domainId));
}

/**
 * map error จาก validateCertificateBundle() เป็น AppError code ที่ UI แยกแยะได้
 *
 * validateCertificateBundle โยน Error ธรรมดาพร้อม message ภาษาไทยที่ actionable อยู่แล้ว —
 * ที่นี่แค่จัดหมวด code ให้ client เลือก UI ที่เหมาะสม (เช่น ชี้ไปที่ field ไหนผิด)
 */
function toTlsAppError(err: unknown): AppError {
  const message = err instanceof Error ? err.message : "certificate ไม่ถูกต้อง";

  if (message.includes("ไม่ตรงกับ certificate")) {
    return new AppError("TLS_CERT_KEY_MISMATCH", message);
  }
  if (message.includes("หมดอายุ") || message.includes("ยังไม่ถึงวันเริ่มใช้งาน")) {
    return new AppError("TLS_CERT_EXPIRED", message);
  }
  if (message.includes("ไม่ครอบ hostname")) {
    return new AppError("TLS_CERT_HOSTNAME_MISMATCH", message);
  }
  if (message.includes("private key")) {
    return new AppError("TLS_KEY_INVALID", message);
  }
  return new AppError("TLS_CERT_INVALID", message);
}

export interface UploadCertificateResult {
  info: TlsCertificateInfo;
  parsed: ParsedCertificate;
}

/**
 * Validate → encrypt → persist certificate ของ domain แล้วสลับ tls_mode เป็น 'custom'
 *
 * เขียนทุก field ในธุรกรรมเดียว — CHECK constraint ใน schema บังคับว่า mode='custom'
 * ต้องมี cert+key ครบคู่ จึงเป็นไปไม่ได้ที่จะเหลือ state ครึ่ง ๆ แม้ process ตายกลางทาง
 */
export async function uploadCertificate(
  db: Database,
  domainId: string,
  certPem: string,
  keyPem: string,
  masterKeys: MasterKeys | null,
): Promise<UploadCertificateResult> {
  const keys = requireMasterKeys(masterKeys);
  const row = loadRow(db, domainId);

  let parsed: ParsedCertificate;
  try {
    parsed = validateCertificateBundle(certPem, keyPem, { hostname: row.hostname });
  } catch (err) {
    throw toTlsAppError(err);
  }

  const [certCiphertext, keyCiphertext] = await Promise.all([
    encryptEnvelope(keys, certPem, certAad(domainId)),
    encryptEnvelope(keys, keyPem, keyAad(domainId)),
  ]);

  const now = Date.now();
  db.query(
    `UPDATE project_domains SET
       tls_mode = 'custom',
       tls_cert_ciphertext = ?, tls_key_ciphertext = ?,
       tls_cert_fingerprint = ?, tls_cert_subject = ?, tls_cert_issuer = ?,
       tls_cert_hostnames = ?, tls_cert_not_before = ?, tls_cert_not_after = ?,
       tls_cert_uploaded_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    certCiphertext,
    keyCiphertext,
    parsed.fingerprint,
    parsed.subject,
    parsed.issuer,
    JSON.stringify(parsed.hostnames),
    parsed.validFrom,
    parsed.validTo,
    now,
    now,
    domainId,
  );

  const info = toInfo(loadRow(db, domainId));
  if (!info) throw new AppError("INTERNAL_ERROR", "certificate หายไปหลังบันทึก");
  return { info, parsed };
}

/**
 * ลบ certificate แล้วกลับไปใช้ Let's Encrypt
 *
 * ล้าง ciphertext ก่อน/พร้อมกับสลับ mode ใน statement เดียว — ทำสองคำสั่งแยกจะติด
 * CHECK constraint (mode='custom' แต่ cert เป็น NULL) ระหว่างทาง
 */
export function removeCertificate(db: Database, domainId: string): void {
  const row = loadRow(db, domainId);
  if (row.tls_mode !== "custom") {
    throw new AppError("TLS_CERT_NOT_FOUND", "domain นี้ไม่ได้ใช้ custom certificate อยู่");
  }

  db.query(
    `UPDATE project_domains SET
       tls_mode = 'letsencrypt',
       tls_cert_ciphertext = NULL, tls_key_ciphertext = NULL,
       tls_cert_fingerprint = NULL, tls_cert_subject = NULL, tls_cert_issuer = NULL,
       tls_cert_hostnames = NULL, tls_cert_not_before = NULL, tls_cert_not_after = NULL,
       tls_cert_uploaded_at = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(Date.now(), domainId);
}

/**
 * decrypt certificate ทุกใบที่ใช้งานอยู่ เพื่อเขียนไฟล์ให้ Traefik (tls/materialize.ts)
 *
 * เฉพาะ domain ที่ enabled=1 และ tls_mode='custom' — disabled domain ไม่ควรมี cert
 * ค้างอยู่ในไฟล์ config เพราะ Traefik จะยัง serve SNI นั้นได้แม้ไม่มี router
 *
 * cert ใบที่ decrypt ไม่ผ่าน (เช่น master key ถูก rotate โดยไม่ re-encrypt) ถูกข้าม
 * และรายงานผ่าน onError แทนที่จะโยน — ไม่ให้ cert เสียใบเดียวทำให้ทั้ง config ไม่ถูกเขียน
 */
export async function decryptActiveCertificates(
  db: Database,
  masterKeys: MasterKeys | null,
  onError?: (domainId: string, hostname: string, message: string) => void,
): Promise<DecryptedCertificate[]> {
  if (!masterKeys) return [];

  const rows = db
    .query<TlsRow, []>(
      `SELECT ${TLS_COLS} FROM project_domains
       WHERE tls_mode = 'custom' AND enabled = 1
         AND tls_cert_ciphertext IS NOT NULL AND tls_key_ciphertext IS NOT NULL
       ORDER BY hostname`,
    )
    .all();

  const result: DecryptedCertificate[] = [];
  for (const row of rows) {
    try {
      const [certPem, keyPem] = await Promise.all([
        decryptEnvelope(
          masterKeys,
          new Uint8Array(row.tls_cert_ciphertext as Buffer),
          certAad(row.id),
        ),
        decryptEnvelope(
          masterKeys,
          new Uint8Array(row.tls_key_ciphertext as Buffer),
          keyAad(row.id),
        ),
      ]);
      result.push({ domainId: row.id, hostname: row.hostname, certPem, keyPem });
    } catch (err) {
      // ห้ามใส่เนื้อ error ของ WebCrypto ลง log ตรง ๆ — ใช้ message กลางแทน
      onError?.(
        row.id,
        row.hostname,
        err instanceof Error ? err.message : "decrypt certificate ไม่สำเร็จ",
      );
    }
  }
  return result;
}
