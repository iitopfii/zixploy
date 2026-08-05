/**
 * Deployment state machine — ดู docs/phase-00-foundation.md
 *
 * queued -> cloning -> building -> starting -> health_checking -> activating -> succeeded
 * ทุก state ก่อน succeeded ไปยัง failed หรือ cancelled ได้
 */

export const DEPLOYMENT_STATUSES = [
  "queued",
  "cloning",
  "building",
  "starting",
  "health_checking",
  "activating",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/** Terminal states — ออกจาก state เหล่านี้ไม่ได้ */
export const TERMINAL_STATUSES: readonly DeploymentStatus[] = ["succeeded", "failed", "cancelled"];

const FORWARD: Partial<Record<DeploymentStatus, DeploymentStatus>> = {
  queued: "cloning",
  cloning: "building",
  building: "starting",
  starting: "health_checking",
  health_checking: "activating",
  activating: "succeeded",
};

/** คืน true เมื่อ transition จาก `from` ไป `to` ถูกต้องตาม state machine */
export function canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  if (TERMINAL_STATUSES.includes(from)) return false;
  if (to === "failed" || to === "cancelled") return true;
  return FORWARD[from] === to;
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: DeploymentStatus,
    readonly to: DeploymentStatus,
  ) {
    super(`invalid deployment transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** ตรวจ transition และ throw เมื่อไม่ถูกต้อง — ใช้ก่อนเขียน DB เสมอ */
export function assertTransition(from: DeploymentStatus, to: DeploymentStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: DeploymentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
