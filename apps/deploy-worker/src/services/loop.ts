/**
 * Service job loop — Phase 10 M3
 *
 * รันคู่กับ jobLoop ของ deploy (index.ts) แต่คนละคิว: database provisioning ใช้เวลานาน
 * (pull image + init) ถ้าใช้คิวเดียวกันจะไปบล็อก deploy ของ app ที่ผู้ใช้รออยู่
 *
 * fail-soft: error ของงานหนึ่งไม่หยุด loop — บันทึกลง service.failure_message ให้ผู้ใช้เห็นใน UI
 */

import type { Database } from "bun:sqlite";
import { DEPLOY_QUEUE } from "@zixploy/shared";
import type { DockerCliClient } from "../docker/cli-client";
import type { MasterKeys } from "../github/master-key";
import {
  destroyService,
  type ProvisionDeps,
  provisionService,
  restartService,
  setServiceStatus,
  startService,
  stopService,
} from "./provision";
import {
  claimNextServiceJob,
  completeServiceJob,
  failServiceJob,
  pruneServiceJobs,
  renewServiceLease,
} from "./queue";

const PRUNE_DONE_AFTER_MS = 24 * 60 * 60 * 1000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * ต่ออายุ lease เป็นระยะระหว่างงานทำงานอยู่
 *
 * provision ใช้เวลาได้ถึง 3 นาที (pull image ใหญ่ + init database) ซึ่งนานกว่า leaseMs
 * ถ้าไม่ต่ออายุ จะถูก recover ไปให้ตัวเองซ้ำ กลายเป็นทำงานซ้อนกันบน container เดียว
 */
async function withLeaseRenewal<T>(
  db: Database,
  jobId: string,
  workerId: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setInterval(() => {
    // ต่ออายุไม่สำเร็จ = lease ถูกคนอื่นยึดไปแล้ว → ยกเลิกงานที่ทำอยู่ทันที
    if (!renewServiceLease(db, jobId, workerId)) controller.abort();
  }, DEPLOY_QUEUE.leaseRenewIntervalMs);

  try {
    return await fn(controller.signal);
  } finally {
    clearInterval(timer);
  }
}

export interface ServiceLoopOptions {
  masterKeys: MasterKeys | null;
  onLog?: (line: string) => void;
}

export async function serviceJobLoop(
  db: Database,
  docker: DockerCliClient,
  workerId: string,
  signal: AbortSignal,
  options: ServiceLoopOptions,
): Promise<void> {
  const onLog = options.onLog ?? (() => {});
  const deps: ProvisionDeps = { db, docker, masterKeys: options.masterKeys, onLog };
  let lastPruneAt = Date.now();

  while (!signal.aborted) {
    let job: ReturnType<typeof claimNextServiceJob> = null;
    try {
      job = claimNextServiceJob(db, workerId);
    } catch {
      // DB busy / index ชน — รอรอบหน้า
    }

    if (!job) {
      if (Date.now() - lastPruneAt > 60 * 60 * 1000) {
        lastPruneAt = Date.now();
        try {
          pruneServiceJobs(db, PRUNE_DONE_AFTER_MS);
        } catch {
          // ไม่สำคัญพอจะหยุด loop
        }
      }
      await sleep(DEPLOY_QUEUE.pollIntervalMs, signal);
      continue;
    }

    const claimed = job;
    onLog(`service job claimed: ${claimed.type} (${claimed.serviceId})`);

    try {
      await withLeaseRenewal(db, claimed.id, workerId, async (jobSignal) => {
        switch (claimed.type) {
          case "provision":
            return provisionService(deps, claimed.serviceId, jobSignal);
          case "start":
            return startService(deps, claimed.serviceId, jobSignal);
          case "stop":
            return stopService(deps, claimed.serviceId);
          case "restart":
            return restartService(deps, claimed.serviceId, jobSignal);
          case "destroy":
            return destroyService(deps, claimed.serviceId);
        }
      });

      completeServiceJob(db, claimed.id);
      onLog(`service job done: ${claimed.type}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failServiceJob(db, claimed.id, message);

      // destroy ที่ล้มเหลวไม่ควรทิ้ง service ไว้ในสถานะ 'deleting' ตลอดกาล — คืนเป็น failed
      // ให้ผู้ใช้เห็นและกดลบซ้ำได้ ส่วนงานอื่นตั้ง failed พร้อมข้อความ
      try {
        setServiceStatus(db, claimed.serviceId, "failed", {
          failureMessage: message.slice(0, 500),
        });
      } catch {
        // service ถูกลบไปแล้ว (destroy สำเร็จบางส่วน) — ไม่มีอะไรต้องอัปเดต
      }

      onLog(`service job failed: ${claimed.type} — ${message}`);
    }
  }
}
