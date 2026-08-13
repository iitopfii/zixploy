/**
 * Job dispatcher — เสียบเป็น processJob จริงใน index.ts's job loop แทน stub ของ M2
 * แยก dependency wiring ออกจาก index.ts เพื่อให้เทสต์ inject mock ทั้งชุดแทนได้ง่าย
 *
 * Phase 6: build/rollback jobs ส่ง onLog ผ่าน makeBuildLogger เพื่อ persist ลง build_logs
 * restart/stop jobs ไม่มี deployment → ใช้ deps.onLog ตรงๆ เหมือนเดิม
 */

import type { Database } from "bun:sqlite";
import { AppError } from "@zixploy/shared";
import { loadProjectMode } from "../db/project-config";
import { buildImage } from "../docker/buildkit";
import type { DockerCliClient } from "../docker/cli-client";
import { cloneCommit } from "../git/clone";
import type { MasterKeys } from "../github/master-key";
import { mintInstallationToken } from "../github/token";
import { checkDiskPressure } from "../logs/retention";
import { makeBuildLogger } from "../logs/writer";
import type { ClaimedJob, JobOutcome } from "../queue";
import { activate } from "./activate";
import { runBuildOrRollbackPipeline } from "./build";
import { waitForHealthy } from "./health-check";
import { runComposePipeline } from "./orchestrate";
import { parseDeployPayload } from "./payload";
import { runRestart, runStop } from "./restart-stop";

export interface DispatchDeps {
  db: Database;
  masterKeys: MasterKeys | null;
  docker: DockerCliClient;
  onLog: (line: string) => void;
}

export type ProcessJobFn = (
  db: Database,
  job: ClaimedJob,
  signal: AbortSignal,
) => Promise<JobOutcome>;

export function createDispatcher(deps: DispatchDeps): ProcessJobFn {
  return async (_db: Database, job: ClaimedJob, signal: AbortSignal): Promise<JobOutcome> => {
    const payload = parseDeployPayload(job.payload);

    if (payload.kind === "build" || payload.kind === "rollback") {
      // disk watermark check (Phase 6 M5) — fail fast ก่อน clone/build ถ้า disk ต่ำ
      // ป้องกัน build ใหม่แย่งพื้นที่ active container (ดู docs/phase-06-logs.md)
      if (await checkDiskPressure()) {
        throw new AppError("DISK_FULL", "disk available ต่ำกว่า threshold — หยุดรับ build ใหม่");
      }

      // build/rollback: persists build output ลง build_logs (Phase 6 M2)
      // secret redaction ทำแล้วใน pipeline (safeLog wrapper ใน build.ts)
      // ก่อนส่งเข้า onLog — writer ไม่ redact ซ้ำ
      const deploymentId = job.deploymentId;
      let persistLog: (line: string) => void = deps.onLog;
      if (deploymentId) {
        const buildLogger = makeBuildLogger(deps.db, deploymentId);
        persistLog = (line) => {
          buildLogger.log(line, "stdout");
          deps.onLog(line);
        };
      }

      // compose projects (mode='compose') → multi-container orchestrator (Phase 18)
      // build เท่านั้น: rollback ของ compose = Phase D (ยังไม่มีตัวสร้าง rollback job ให้ compose)
      // single mode วิ่ง pipeline เดิม byte-for-byte — ไม่มี project ไหนเป็น compose จนกว่าจะมี UI (C3)
      if (payload.kind === "build" && loadProjectMode(deps.db, job.projectId) === "compose") {
        return runComposePipeline(
          {
            db: deps.db,
            docker: deps.docker,
            masterKeys: deps.masterKeys,
            mintInstallationToken,
            cloneCommit,
            buildImage,
            waitForHealthy,
            onLog: persistLog,
          },
          job,
          payload,
          signal,
        );
      }

      return runBuildOrRollbackPipeline(
        {
          db: deps.db,
          docker: deps.docker,
          masterKeys: deps.masterKeys,
          mintInstallationToken,
          cloneCommit,
          buildImage,
          waitForHealthy,
          activate,
          onLog: persistLog,
        },
        job,
        payload,
        signal,
      );
    }

    if (payload.kind === "restart") {
      return runRestart(deps.db, deps.docker, job);
    }

    return runStop(deps.db, deps.docker, job);
  };
}
