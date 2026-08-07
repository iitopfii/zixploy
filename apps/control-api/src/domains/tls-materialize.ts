/**
 * เขียน custom certificate ลง disk ให้ Traefik file provider อ่าน — docs/phase-05-domains.md M5
 *
 * ทำไมต้องเขียนไฟล์: Traefik รับ certificate จาก 2 ทางเท่านั้น — ACME (certresolver) หรือ
 * dynamic configuration ผ่าน file provider Docker label ใส่ cert ตรง ๆ ไม่ได้ ดังนั้น custom cert
 * ต้อง materialize เป็นไฟล์บน volume ที่ Traefik mount ไว้ แล้ว Traefik จับคู่ cert กับ SNI เอง
 * (ไม่ต้องผูกกับ router — Traefik เลือกจาก SAN ของ cert ให้อัตโนมัติ)
 *
 * Layout บน volume (ZIXPLOY_TLS_DIR, default /certs):
 *   <dir>/certs/<domain_id>.crt          full chain PEM
 *   <dir>/certs/<domain_id>.key          private key PEM (mode 0600)
 *   <dir>/dynamic/certificates.json      Traefik dynamic config ที่อ้างถึงไฟล์ข้างบน
 *
 * Security:
 * - private key เขียนด้วย mode 0600 เสมอ (0644 = อ่านได้ทุก process ในเครื่อง)
 * - ชื่อไฟล์มาจาก domain id (ULID ที่ระบบสร้างเอง) ไม่ใช่ hostname ที่ผู้ใช้ป้อน
 *   → path traversal เป็นไปไม่ได้ตั้งแต่ต้นทาง แต่ยังมี assertSafeId() กันไว้อีกชั้น
 * - config เขียนแบบ atomic (tmp → rename) — Traefik watch ไฟล์อยู่ ถ้าอ่านเจอ JSON
 *   ที่เขียนค้างครึ่งทางจะ log error แล้วทิ้ง config ทั้งไฟล์ (cert ทุกใบหายพร้อมกัน)
 * - JSON ไม่ใช่ YAML โดยตั้งใจ: JSON.stringify escape ให้ครบเอง ไม่ต้องเขียน YAML quoting
 *   เอง (ซึ่งพลาดง่ายและกลายเป็น config injection ได้)
 */

import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "@zixploy/shared";
import type { DecryptedCertificate } from "./tls-store";

/** path ที่ Traefik mount — ต้องตรงกับ deploy/server/docker-compose.yml */
export const DEFAULT_TLS_DIR = "/certs";

export function tlsDir(): string {
  return process.env.ZIXPLOY_TLS_DIR ?? DEFAULT_TLS_DIR;
}

/**
 * path ที่ **Traefik** เห็น (ต่างจากที่ control-api เขียนได้ ถ้า mount คนละจุด)
 * ค่าที่ใส่ใน dynamic config ต้องเป็น path ฝั่ง Traefik เท่านั้น
 */
function traefikTlsDir(): string {
  return process.env.ZIXPLOY_TLS_DIR_TRAEFIK ?? tlsDir();
}

/** id ต้องเป็น [A-Za-z0-9] ล้วน (ULID) — กัน `..`/separator หลุดเข้า path ถ้ามีบั๊กต้นทาง */
function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9]{1,64}$/.test(id)) {
    throw new AppError("TLS_MATERIALIZE_FAILED", `domain id ไม่ปลอดภัยสำหรับใช้เป็นชื่อไฟล์: ${id}`);
  }
}

export interface MaterializeResult {
  /** จำนวน cert ที่เขียนสำเร็จ */
  written: number;
  /** ไฟล์ที่ลบทิ้งเพราะ domain ถูกลบ/เปลี่ยนกลับเป็น letsencrypt */
  removed: string[];
  /** path ของ dynamic config ที่เขียน */
  configPath: string;
}

/**
 * เขียน cert ทั้งชุดลง disk แล้ว regenerate dynamic config
 *
 * เป็น **full sync** ไม่ใช่ incremental: certs ที่ส่งเข้ามาคือ "สถานะที่ควรเป็นทั้งหมด"
 * ไฟล์ .crt/.key ที่เหลืออยู่ใน dir แต่ไม่อยู่ในชุดนี้จะถูกลบ — domain ที่ถูกลบหรือ
 * ปิด custom TLS ไปแล้วต้องไม่เหลือ cert ค้างให้ Traefik serve ต่อ
 */
export function materializeCertificates(certs: DecryptedCertificate[]): MaterializeResult {
  const baseDir = tlsDir();
  const certsDir = join(baseDir, "certs");
  const dynamicDir = join(baseDir, "dynamic");

  try {
    mkdirSync(certsDir, { recursive: true });
    mkdirSync(dynamicDir, { recursive: true });
  } catch (err) {
    throw new AppError(
      "TLS_MATERIALIZE_FAILED",
      `สร้างโฟลเดอร์ certificate ไม่ได้: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const expectedFiles = new Set<string>();

  for (const cert of certs) {
    assertSafeId(cert.domainId);
    const certFile = `${cert.domainId}.crt`;
    const keyFile = `${cert.domainId}.key`;
    expectedFiles.add(certFile);
    expectedFiles.add(keyFile);

    // cert ก่อน key เสมอ: ถ้าตายกลางคัน จะเหลือ cert ที่ไม่มี key (Traefik ข้ามพร้อม log)
    // ซึ่งดีกว่าเหลือ key ที่ไม่มี cert อ้างถึง (key หลุดอยู่บน disk โดยไม่มีใครใช้)
    writeAtomic(join(certsDir, certFile), cert.certPem, 0o644);
    writeAtomic(join(certsDir, keyFile), cert.keyPem, 0o600);
  }

  // ลบไฟล์ที่ไม่ควรมีอยู่แล้ว
  const removed: string[] = [];
  for (const name of readdirSync(certsDir)) {
    if (!name.endsWith(".crt") && !name.endsWith(".key")) continue;
    if (expectedFiles.has(name)) continue;
    try {
      rmSync(join(certsDir, name), { force: true });
      removed.push(name);
    } catch {
      // ลบไม่ได้ไม่ควรทำให้ทั้งการ sync ล้ม — cert ที่ควรมีเขียนสำเร็จไปแล้ว
    }
  }

  // dynamic config — path ต้องเป็นมุมมองของ Traefik ไม่ใช่ของ control-api
  const traefikCertsDir = join(traefikTlsDir(), "certs").replace(/\\/g, "/");
  const config = {
    tls: {
      certificates: certs.map((cert) => ({
        certFile: `${traefikCertsDir}/${cert.domainId}.crt`,
        keyFile: `${traefikCertsDir}/${cert.domainId}.key`,
      })),
    },
  };

  const configPath = join(dynamicDir, "certificates.json");
  writeAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o644);

  return { written: certs.length, removed, configPath };
}

/**
 * เขียนไฟล์แบบ atomic — tmp file ในโฟลเดอร์เดียวกันแล้ว rename ทับ
 * (rename ข้าม filesystem ไม่ atomic จึงต้องอยู่โฟลเดอร์เดียวกันเสมอ)
 *
 * chmod ทำบน tmp **ก่อน** rename — ไม่งั้นจะมีช่วงเวลาสั้น ๆ ที่ key อยู่บน disk ด้วย
 * permission เริ่มต้นของ process (umask) ซึ่งอาจกว้างกว่าที่ตั้งใจ
 */
function writeAtomic(path: string, content: string, mode: number): void {
  const tmpPath = `${path}.tmp`;
  try {
    writeFileSync(tmpPath, content, { mode });
    chmodSync(tmpPath, mode);
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best effort — ไฟล์ tmp ค้างไม่กระทบ Traefik (นามสกุล .tmp ไม่ถูกโหลด)
    }
    throw new AppError(
      "TLS_MATERIALIZE_FAILED",
      `เขียนไฟล์ certificate ไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
