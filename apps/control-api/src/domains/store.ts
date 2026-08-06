/**
 * Domain DB operations — docs/phase-05-domains.md M3
 *
 * ทุก write ผ่าน validateHostname() ก่อนเสมอ (caller ต้องเรียกเอง)
 * ห้าม return plaintext ciphertext หรือ internal column ที่ไม่จำเป็น
 */

import type { Database } from "bun:sqlite";
import { AppError, ulid } from "@zixploy/shared";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface DomainRow {
  id: string;
  project_id: string;
  hostname: string;
  internal_port: number;
  https_enabled: number;
  redirect_http: number;
  redirect_mode: string;
  dns_status: string;
  dns_checked_at: number | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export interface DomainDto {
  id: string;
  projectId: string;
  hostname: string;
  internalPort: number;
  httpsEnabled: boolean;
  redirectHttp: boolean;
  redirectMode: "none" | "www_to_root" | "root_to_www";
  dnsStatus: "pending" | "valid" | "mismatch" | "unknown";
  dnsCheckedAt: number | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

function toDto(row: DomainRow): DomainDto {
  return {
    id: row.id,
    projectId: row.project_id,
    hostname: row.hostname,
    internalPort: row.internal_port,
    httpsEnabled: row.https_enabled === 1,
    redirectHttp: row.redirect_http === 1,
    redirectMode: row.redirect_mode as DomainDto["redirectMode"],
    dnsStatus: row.dns_status as DomainDto["dnsStatus"],
    dnsCheckedAt: row.dns_checked_at,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_ALL = `
  id, project_id, hostname, internal_port,
  https_enabled, redirect_http, redirect_mode,
  dns_status, dns_checked_at, enabled,
  created_at, updated_at
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function listDomains(db: Database, projectId: string): DomainDto[] {
  return db
    .query<DomainRow, [string]>(
      `SELECT ${SELECT_ALL} FROM project_domains WHERE project_id = ? ORDER BY created_at ASC`,
    )
    .all(projectId)
    .map(toDto);
}

export function getDomain(db: Database, id: string): DomainRow | null {
  return (
    db
      .query<DomainRow, [string]>(`SELECT ${SELECT_ALL} FROM project_domains WHERE id = ?`)
      .get(id) ?? null
  );
}

export interface CreateDomainInput {
  hostname: string; // ต้องผ่าน validateHostname() แล้ว
  internalPort: number;
  httpsEnabled?: boolean;
  redirectHttp?: boolean;
  redirectMode?: "none" | "www_to_root" | "root_to_www";
}

export function createDomain(db: Database, projectId: string, input: CreateDomainInput): DomainDto {
  const now = Date.now();
  const id = ulid();

  try {
    db.query(
      `INSERT INTO project_domains
        (id, project_id, hostname, internal_port, https_enabled, redirect_http, redirect_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      projectId,
      input.hostname,
      input.internalPort,
      input.httpsEnabled !== false ? 1 : 0,
      input.redirectHttp !== false ? 1 : 0,
      input.redirectMode ?? "none",
      now,
      now,
    );
  } catch (err) {
    // UNIQUE constraint on hostname
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      throw new AppError(
        "DOMAIN_DUPLICATE",
        `hostname "${input.hostname}" ถูกใช้งานโดย project อื่นแล้ว`,
      );
    }
    throw err;
  }

  const inserted = getDomain(db, id);
  if (!inserted) throw new AppError("INTERNAL_ERROR", "domain disappeared after insert");
  return toDto(inserted);
}

export interface UpdateDomainInput {
  internalPort?: number;
  httpsEnabled?: boolean;
  redirectHttp?: boolean;
  redirectMode?: "none" | "www_to_root" | "root_to_www";
  enabled?: boolean;
}

export function updateDomain(db: Database, id: string, input: UpdateDomainInput): DomainDto {
  const row = getDomain(db, id);
  if (!row) throw new AppError("DOMAIN_NOT_FOUND", "ไม่พบ domain นี้");

  const fields: string[] = [];
  const values: (string | number)[] = [];

  const set = (col: string, val: string | number) => {
    fields.push(`${col} = ?`);
    values.push(val);
  };

  if (input.internalPort !== undefined) set("internal_port", input.internalPort);
  if (input.httpsEnabled !== undefined) set("https_enabled", input.httpsEnabled ? 1 : 0);
  if (input.redirectHttp !== undefined) set("redirect_http", input.redirectHttp ? 1 : 0);
  if (input.redirectMode !== undefined) set("redirect_mode", input.redirectMode);
  if (input.enabled !== undefined) set("enabled", input.enabled ? 1 : 0);

  if (fields.length > 0) {
    const now = Date.now();
    set("updated_at", now);
    values.push(id);
    db.query(`UPDATE project_domains SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  const updated = getDomain(db, id);
  if (!updated) throw new AppError("INTERNAL_ERROR", "domain disappeared after update");
  return toDto(updated);
}

export function deleteDomain(db: Database, id: string): void {
  const row = getDomain(db, id);
  if (!row) throw new AppError("DOMAIN_NOT_FOUND", "ไม่พบ domain นี้");
  db.query("DELETE FROM project_domains WHERE id = ?").run(id);
}

/** อัปเดต dns_status + dns_checked_at — เรียกจาก DNS check service */
export function updateDnsStatus(
  db: Database,
  id: string,
  status: "pending" | "valid" | "mismatch" | "unknown",
): DomainDto {
  const row = getDomain(db, id);
  if (!row) throw new AppError("DOMAIN_NOT_FOUND", "ไม่พบ domain นี้");

  const now = Date.now();
  db.query(
    "UPDATE project_domains SET dns_status = ?, dns_checked_at = ?, updated_at = ? WHERE id = ?",
  ).run(status, now, now, id);

  const afterCheck = getDomain(db, id);
  if (!afterCheck) throw new AppError("INTERNAL_ERROR", "domain disappeared after dns update");
  return toDto(afterCheck);
}
