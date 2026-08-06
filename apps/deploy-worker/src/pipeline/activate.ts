/**
 * Activation — ADR-0004 start-before-stop
 *
 * ถึงจุดนี้ candidate container ผ่าน health check แล้ว (caller รับประกัน) — เหลือแค่
 * รอ drain period แล้วปิด container เก่า ถ้ามี (project deploy ครั้งแรกไม่มีของเก่าให้ปิด)
 *
 * candidate เชื่อมกับ zixploy-proxy network ไปแล้วตั้งแต่ตอน createContainer (M6 build.ts)
 * — Phase 3 ไม่ตั้ง Traefik label ใด ๆ (ไม่มี domains table จนกว่าจะถึง Phase 5)
 */

import type { DockerCliClient } from "../docker/cli-client";

/** default drain period ก่อนปิด container เก่า — ยังไม่ใช่ project setting ใน Phase 3 */
export const DEFAULT_DRAIN_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ActivateParams {
  docker: DockerCliClient;
  /** container ของ deployment ที่ succeeded ก่อนหน้า — null ถ้าเป็นการ deploy ครั้งแรกของ project */
  oldContainerId: string | null;
  drainMs?: number;
}

export async function activate(params: ActivateParams): Promise<void> {
  const { docker, oldContainerId, drainMs = DEFAULT_DRAIN_MS } = params;
  if (!oldContainerId) return;

  await sleep(drainMs);
  await docker.stopContainer(oldContainerId);
  await docker.removeContainer(oldContainerId, { force: true });
}
