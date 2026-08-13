/**
 * Managed-ref connection env — Phase 18 · Phase F
 *
 * component ที่ depends_on component แบบ managed_ref (อ้าง managed database ของแพลตฟอร์ม) จะได้
 * env เชื่อมต่อฉีดเข้ามาอัตโนมัติตอน deploy: connection URI เต็ม + ตัวแปรแยก (host/port/user/pass/db)
 * ตั้งชื่อตาม prefix ของชื่อ managed_ref component (เช่น ref ชื่อ "db" → DB_URL, DB_HOST, …)
 *
 * host = ชื่อ container ของ service บน PROXY_NETWORK (serviceContainerName) — dependent component
 * ต้อง join PROXY_NETWORK ถึงจะ resolve ชื่อนี้ได้ (orchestrator จัดการ connect ให้เมื่อมี managed_ref dep)
 *
 * ถอดรหัสผ่านด้วย readCredentials เดียวกับที่ provision/backup ใช้ (AAD ตรงกับ control-api เป๊ะ)
 */

import type { Database } from "bun:sqlite";
import { connectionUri, isServiceType, serviceContainerName } from "@zixploy/shared";
import type { MasterKeys } from "../github/master-key";
import { loadService, readCredentials } from "../services/provision";
import type { DeployComponent } from "./components-loader";

/** ชื่อ component (DNS label) → prefix ของ env var: "db-main" → "DB_MAIN" */
function envPrefix(name: string): string {
  return name.toUpperCase().replace(/-/g, "_");
}

/**
 * สร้าง env เชื่อม managed database ให้ dependent ของ managed_ref หนึ่งตัว
 * คืน {} ถ้า ref ไม่มี managedServiceId หรือ service หาย (graceful) — ส่วนถ้าถอดรหัสผ่านไม่ได้จะ
 * throw (readCredentials) เพื่อให้ deploy fail ชัด ๆ แทนปล่อยแอปที่ต่อ DB ไม่ได้ออกไปเงียบ ๆ
 */
export async function buildManagedRefEnv(
  db: Database,
  masterKeys: MasterKeys | null,
  ref: DeployComponent,
): Promise<Record<string, string>> {
  if (!ref.managedServiceId) return {};
  const row = loadService(db, ref.managedServiceId);
  if (!row || !isServiceType(row.type)) return {};

  const creds = await readCredentials(masterKeys, row);
  const host = serviceContainerName(row.id);
  const uri = connectionUri(row.type, creds, host, row.internal_port);
  const p = envPrefix(ref.name);
  return {
    [`${p}_URL`]: uri,
    [`${p}_HOST`]: host,
    [`${p}_PORT`]: String(row.internal_port),
    [`${p}_USERNAME`]: creds.username,
    [`${p}_PASSWORD`]: creds.password,
    [`${p}_DATABASE`]: creds.database,
  };
}
