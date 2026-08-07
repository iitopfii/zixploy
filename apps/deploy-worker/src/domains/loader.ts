/**
 * Domain loader สำหรับ deploy-worker — docs/phase-05-domains.md M4
 *
 * อ่าน project_domains จาก DB โดยตรง (worker ไม่ RPC control-api — ADR-0002)
 * คืนเฉพาะ domain ที่ enabled=1 เท่านั้น — disabled domain จะไม่มี Traefik labels
 */

import type { Database } from "bun:sqlite";
import type { DomainConfig, TlsMode } from "@zixploy/shared";

interface DomainRow {
  hostname: string;
  internal_port: number;
  https_enabled: number;
  redirect_http: number;
  redirect_mode: string;
  tls_mode: string;
}

/**
 * โหลด domain configs ที่ enabled สำหรับ project
 * คืน DomainConfig[] พร้อมส่งเข้า buildTraefikLabels() โดยตรง
 */
export function loadProjectDomains(db: Database, projectId: string): DomainConfig[] {
  const rows = db
    .query<DomainRow, [string]>(
      `SELECT hostname, internal_port, https_enabled, redirect_http, redirect_mode, tls_mode
       FROM project_domains
       WHERE project_id = ? AND enabled = 1
       ORDER BY created_at ASC`,
    )
    .all(projectId);

  return rows.map((row) => ({
    hostname: row.hostname,
    internalPort: row.internal_port,
    httpsEnabled: row.https_enabled === 1,
    redirectHttp: row.redirect_http === 1,
    redirectMode: row.redirect_mode as DomainConfig["redirectMode"],
    // custom → label ต้องไม่มี certresolver ไม่งั้น Traefik ขอ ACME cert ทับใบที่อัปโหลดไว้
    tlsMode: row.tls_mode as TlsMode,
  }));
}
