/**
 * Job dispatcher — เสียบเป็น processJob จริงใน index.ts's job loop แทน stub ของ M2
 * แยก dependency wiring ออกจาก index.ts เพื่อให้เทสต์ inject mock ทั้งชุดแทนได้ง่าย
 */

import type { Database } from "bun:sqlite";
import { buildImage } from "../docker/buildkit";
import type { DockerCliClient } from "../docker/cli-client";
import { cloneCommit } from "../git/clone";
import type { MasterKeys } from "../github/master-key";
import { mintInstallationToken } from "../github/token";
import type { ClaimedJob, JobOutcome } from "../queue";
import { activate } from "./activate";
import { runBuildOrRollbackPipeline } from "./build";
import { waitForHealthy } from "./health-check";
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
          onLog: deps.onLog,
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
