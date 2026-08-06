/**
 * Deployment state transitions — ทุกครั้งเรียก assertTransition ก่อนเขียน DB เสมอ (@zixploy/shared)
 *
 * เขียน DB status ก่อนเริ่ม side effect เสมอ (ไม่ใช่หลัง) — ถ้า worker ตายกลางทาง DB จะบอกว่า
 * "กำลังพยายามทำ X" ไม่ใช่ "ทำ X เสร็จแล้ว" ทำให้ recovery รู้ว่าต้อง retry step ไหน
 */

import type { Database } from "bun:sqlite";
import { assertTransition, type DeploymentStatus } from "@zixploy/shared";

const STATE_TIMESTAMP_COLUMN: Partial<Record<DeploymentStatus, string>> = {
  cloning: "cloning_at",
  building: "building_at",
  starting: "starting_at",
  health_checking: "health_checking_at",
  activating: "activating_at",
};

export interface DeploymentTransitionExtra {
  imageTag?: string;
  imageDigest?: string;
  containerId?: string;
  failureCode?: string;
  failureMessage?: string;
}

function currentStatus(db: Database, deploymentId: string): DeploymentStatus {
  const row = db
    .query<{ status: string }, [string]>("SELECT status FROM deployments WHERE id = ?")
    .get(deploymentId);
  if (!row) throw new Error(`deployment ${deploymentId} ไม่พบใน DB`);
  return row.status as DeploymentStatus;
}

/** อ่าน status แบบไม่ throw — null ถ้าไม่พบ deployment (ใช้ guard ก่อน mark failed กัน race กับ recoverStaleLeases) */
export function getDeploymentStatus(db: Database, deploymentId: string): DeploymentStatus | null {
  const row = db
    .query<{ status: string }, [string]>("SELECT status FROM deployments WHERE id = ?")
    .get(deploymentId);
  return row ? (row.status as DeploymentStatus) : null;
}

/**
 * เปลี่ยน status พร้อม assertTransition — throw ถ้า transition ไม่ถูกต้องตาม state machine
 * (ป้องกัน bug ใน pipeline logic เอง ไม่ใช่กัน user input เพราะ worker เป็นฝ่ายเดียวที่เขียนตรงนี้)
 */
export function transitionDeployment(
  db: Database,
  deploymentId: string,
  to: DeploymentStatus,
  extra: DeploymentTransitionExtra = {},
): void {
  const from = currentStatus(db, deploymentId);
  assertTransition(from, to);

  const now = Date.now();
  const fields: string[] = ["status = ?", "updated_at = ?"];
  const values: (string | number | null)[] = [to, now];

  // started_at: ตั้งครั้งแรกที่ออกจาก queued (เข้า cloning หรือ starting กรณี rollback ที่ข้าม cloning/building)
  if (from === "queued") {
    fields.push("started_at = ?");
    values.push(now);
  }

  const timestampColumn = STATE_TIMESTAMP_COLUMN[to];
  if (timestampColumn) {
    fields.push(`${timestampColumn} = ?`);
    values.push(now);
  }

  if (to === "succeeded" || to === "failed" || to === "cancelled") {
    fields.push("finished_at = ?");
    values.push(now);
  }

  if (extra.imageTag !== undefined) {
    fields.push("image_tag = ?");
    values.push(extra.imageTag);
  }
  if (extra.imageDigest !== undefined) {
    fields.push("image_digest = ?");
    values.push(extra.imageDigest);
  }
  if (extra.containerId !== undefined) {
    fields.push("container_id = ?");
    values.push(extra.containerId);
  }
  if (extra.failureCode !== undefined) {
    fields.push("failure_code = ?");
    values.push(extra.failureCode);
  }
  if (extra.failureMessage !== undefined) {
    fields.push("failure_message = ?");
    values.push(extra.failureMessage);
  }

  values.push(deploymentId);
  db.query(`UPDATE deployments SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

/** shortcut: mark failed พร้อม error code/message — เรียกได้จากทุก non-terminal state */
export function failDeployment(
  db: Database,
  deploymentId: string,
  failureCode: string,
  failureMessage: string,
): void {
  transitionDeployment(db, deploymentId, "failed", { failureCode, failureMessage });
}

/** shortcut: mark cancelled — idempotent-safe ถ้า caller เช็ค isTerminal ก่อนเรียกเองแล้ว */
export function cancelDeploymentRecord(db: Database, deploymentId: string): void {
  transitionDeployment(db, deploymentId, "cancelled");
}

/**
 * ข้อยกเว้นเดียวที่ตั้งใจของ strict forward-only state machine — rollback ข้าม cloning/building
 * ไปตรง ๆ (ไม่มี source ให้ clone, ไม่มี build ให้ทำ — ใช้ image เดิมที่ verify แล้วว่ายังอยู่จริง)
 * cloning_at/building_at ตั้งใจปล่อยเป็น null เพื่อสะท้อนว่าไม่มี work จริงเกิดขึ้นสองขั้นนี้
 *
 * ไม่แก้ FORWARD map ใน @zixploy/shared (ใช้ร่วมกับ control-api) เพราะ map เดิมเป็น 1:1
 * (queued ชี้ไป cloning อยู่แล้ว) — เพิ่ม edge ที่สองให้ queued ทำไม่ได้ในโครงสร้างเดิม ทำ exception
 * นี้ scoped อยู่แค่ฝั่ง worker เอง พร้อม precondition check ของตัวเอง (ต้องมาจาก queued เท่านั้น)
 */
export function transitionToStartingForRollback(db: Database, deploymentId: string): void {
  const from = currentStatus(db, deploymentId);
  if (from !== "queued") {
    throw new Error(`rollback ต้องเริ่ม transition จาก queued เท่านั้น — ได้ ${from}`);
  }
  const now = Date.now();
  db.query(
    "UPDATE deployments SET status = 'starting', started_at = ?, starting_at = ?, updated_at = ? WHERE id = ?",
  ).run(now, now, now, deploymentId);
}
