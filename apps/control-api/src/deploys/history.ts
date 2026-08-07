/**
 * ลบประวัติ deployment — Phase 11
 *
 * ประวัติที่ยาวขึ้นเรื่อย ๆ ทำให้หน้า Deploy โหลดช้าและ build_logs กินดิสก์
 * แต่การลบต้องระวังมาก เพราะมีของที่อ้างอิงแถวเหล่านี้อยู่จริง:
 *
 * 1. **deployment ที่ active อยู่** (ล่าสุดที่ succeeded และมี container_id)
 *    restart/stop/rollback และ reconciler ทั้งหมดหา container จากแถวนี้
 *    ลบทิ้ง = ปุ่ม restart/stop พัง และ reconciler จะ mark project degraded ผิด ๆ
 *
 * 2. **deployment ที่ยังทำงานอยู่** — ลบระหว่าง worker กำลัง build ทำให้ worker
 *    เขียน status กลับไม่ได้ และงานค้างในคิว
 *
 * 3. **deploy_jobs.deployment_id** — FK ที่ไม่มี ON DELETE CASCADE
 *    ต้องลบ job ที่จบแล้วซึ่งอ้างถึงก่อน ไม่งั้น DELETE ล้มด้วย FK constraint
 *    (build_logs มี CASCADE อยู่แล้ว จึงหายตามเอง)
 */

import type { Database } from "bun:sqlite";
import { AppError, type DeploymentStatus, isTerminal } from "@zixploy/shared";

export interface DeleteResult {
  deleted: number;
  /** จำนวนที่ข้ามเพราะลบไม่ได้ พร้อมเหตุผล — คืนให้ UI บอกผู้ใช้ตรง ๆ */
  skipped: Array<{ id: string; reason: string }>;
}

interface Row {
  id: string;
  status: string;
  container_id: string | null;
}

/**
 * id ของ deployment ที่ container ยังให้บริการอยู่
 *
 * นิยามเดียวกับที่ worker/reconciler ใช้หา active container เป๊ะ ๆ
 * (ล่าสุดที่ succeeded + มี container_id เรียงตาม finished_at)
 * ถ้านิยามสองที่ต่างกันเมื่อไหร่ จะลบแถวที่ระบบยังใช้อยู่โดยไม่รู้ตัว
 */
export function activeDeploymentId(db: Database, projectId: string): string | null {
  const row = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM deployments
        WHERE project_id = ? AND status = 'succeeded' AND container_id IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1`,
    )
    .get(projectId);
  return row?.id ?? null;
}

/** เหตุผลที่ลบแถวนี้ไม่ได้ — null = ลบได้ */
function blockReason(row: Row, activeId: string | null): string | null {
  if (!isTerminal(row.status as DeploymentStatus)) {
    return "กำลังทำงานอยู่ — ยกเลิกก่อนจึงจะลบได้";
  }
  if (row.id === activeId) {
    return "เป็นเวอร์ชันที่ให้บริการอยู่ — ลบแล้ว restart/rollback จะใช้ไม่ได้";
  }
  return null;
}

/**
 * ลบแถวเดียว — ลบ deploy_jobs ที่อ้างถึงก่อนใน transaction เดียวกัน
 * build_logs หายเองผ่าน ON DELETE CASCADE
 */
function deleteRow(db: Database, deploymentId: string): void {
  db.transaction(() => {
    db.query("DELETE FROM deploy_jobs WHERE deployment_id = ?").run(deploymentId);
    db.query("DELETE FROM deployments WHERE id = ?").run(deploymentId);
  })();
}

export function deleteDeployment(
  db: Database,
  projectId: string,
  deploymentId: string,
): DeleteResult {
  const row = db
    .query<Row, [string, string]>(
      "SELECT id, status, container_id FROM deployments WHERE id = ? AND project_id = ?",
    )
    .get(deploymentId, projectId);

  if (!row) throw new AppError("DEPLOYMENT_NOT_FOUND", "ไม่พบ deployment นี้");

  const reason = blockReason(row, activeDeploymentId(db, projectId));
  if (reason) throw new AppError("INVALID_STATE_TRANSITION", `ลบไม่ได้: ${reason}`);

  deleteRow(db, deploymentId);
  return { deleted: 1, skipped: [] };
}

/**
 * ลบประวัติทั้งหมดที่ลบได้ โดยเก็บ N รายการล่าสุดไว้
 *
 * keep = 0 หมายถึงเก็บเฉพาะที่ลบไม่ได้ (active + ที่กำลังทำงาน) เท่านั้น
 * ไม่ลบ image — image เป็นของ cleanup worker ตาม retention policy (ADR-0005)
 * ลบแถว DB แต่ยังมี image ค้างดีกว่าลบ image ที่ rollback ยังต้องใช้
 */
export function pruneDeploymentHistory(db: Database, projectId: string, keep = 0): DeleteResult {
  const activeId = activeDeploymentId(db, projectId);

  const rows = db
    .query<Row, [string]>(
      `SELECT id, status, container_id FROM deployments
        WHERE project_id = ? ORDER BY created_at DESC, id DESC`,
    )
    .all(projectId);

  const skipped: Array<{ id: string; reason: string }> = [];
  let deleted = 0;

  rows.forEach((row, index) => {
    if (index < keep) return; // N รายการล่าสุดเก็บไว้เสมอ ไม่ต้องรายงานเป็น skipped

    const reason = blockReason(row, activeId);
    if (reason) {
      skipped.push({ id: row.id, reason });
      return;
    }
    deleteRow(db, row.id);
    deleted++;
  });

  return { deleted, skipped };
}

/** จำนวน deployment ทั้งหมดของ project — UI ใช้แสดง "แสดง 1-20 จาก N" */
export function countDeployments(db: Database, projectId: string): number {
  const row = db
    .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM deployments WHERE project_id = ?")
    .get(projectId);
  return row?.c ?? 0;
}
