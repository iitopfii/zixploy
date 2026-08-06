/**
 * restart/stop — ไม่แตะ deployments table เลย (ไม่ใช่ deployment ใหม่ แค่ operate container ของ
 * deployment ที่ succeeded ล่าสุด) job.deploymentId ถูกตั้งโดย control-api's enqueueOperation
 * ให้ชี้ไป deployment นั้นแล้ว
 */

import type { Database } from "bun:sqlite";
import { AppError } from "@zixploy/shared";
import { setProjectStatus } from "../db/project-config";
import type { DockerCliClient } from "../docker/cli-client";
import type { ClaimedJob } from "../queue";

interface DeploymentContainerRow {
  container_id: string | null;
}

function loadContainerId(db: Database, deploymentId: string): string | null {
  const row = db
    .query<DeploymentContainerRow, [string]>("SELECT container_id FROM deployments WHERE id = ?")
    .get(deploymentId);
  return row?.container_id ?? null;
}

export async function runRestart(
  db: Database,
  docker: DockerCliClient,
  job: ClaimedJob,
): Promise<{ outcome: "done" } | { outcome: "failed"; retryable: false }> {
  if (!job.deploymentId) return { outcome: "failed", retryable: false };
  const containerId = loadContainerId(db, job.deploymentId);
  if (!containerId) return { outcome: "failed", retryable: false };

  try {
    await docker.stopContainer(containerId);
    await docker.startContainer(containerId);
    return { outcome: "done" };
  } catch (err) {
    if (err instanceof AppError) return { outcome: "failed", retryable: false };
    throw err;
  }
}

export async function runStop(
  db: Database,
  docker: DockerCliClient,
  job: ClaimedJob,
): Promise<{ outcome: "done" } | { outcome: "failed"; retryable: false }> {
  if (!job.deploymentId) return { outcome: "failed", retryable: false };
  const containerId = loadContainerId(db, job.deploymentId);
  if (!containerId) return { outcome: "failed", retryable: false };

  try {
    await docker.stopContainer(containerId);
    setProjectStatus(db, job.projectId, "stopped");
    return { outcome: "done" };
  } catch (err) {
    if (err instanceof AppError) return { outcome: "failed", retryable: false };
    throw err;
  }
}
