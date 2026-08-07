/**
 * Metrics collection loop — Phase 9 (server monitoring)
 *
 * รันคู่กับ heartbeatLoop/jobLoop/runtimeLogLoop/reconcile loops ใน index.ts
 * เก็บทุก MONITORING.sampleIntervalMs แล้ว prune ทุก MONITORING.pruneIntervalMs
 *
 * Architecture: worker เป็นผู้เดียวที่แตะ Docker และ /proc ของ host (ADR-0002)
 * control-api อ่านผลจาก DB เท่านั้น ไม่มีทางเรียก collector นี้ตรง ๆ
 *
 * fail-soft ทั้งหมด: error ในรอบหนึ่งไม่หยุด loop — metrics ขาดช่วงยอมรับได้
 * แต่ worker ต้องไม่ตายเพราะเก็บ metrics ไม่ได้ (deploy สำคัญกว่า monitoring)
 */

import type { Database } from "bun:sqlite";
import { MONITORING } from "@zixploy/shared";
import type { DockerCliClient } from "../docker/cli-client";
import { collectContainerSamples } from "./containers";
import { HostMetricsReader } from "./host";
import { insertContainerSamples, insertHostSample, pruneMetrics } from "./store";

/**
 * path ที่ใช้วัดพื้นที่ดิสก์ — ต้องเป็น Docker volume mount ไม่ใช่ path ใน container filesystem
 *
 * /workspaces (zixploy-workspaces volume) อยู่บน filesystem เดียวกับ /var/lib/docker บน host
 * ซึ่งเก็บทั้ง image, volume และ build context — เป็นตัวเลขที่มีความหมายจริงเวลาดิสก์ใกล้เต็ม
 */
function diskPath(): string {
  return process.env.ZIXPLOY_METRICS_DISK_PATH ?? process.env.ZIXPLOY_WORKSPACES_DIR ?? "/";
}

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

export interface MetricsLoopOptions {
  /** override path ที่วัดดิสก์ — ใช้ในเทสต์ */
  diskPath?: string;
  onLog?: (line: string) => void;
}

export async function metricsLoop(
  db: Database,
  docker: DockerCliClient,
  signal: AbortSignal,
  options: MetricsLoopOptions = {},
): Promise<void> {
  const host = new HostMetricsReader(options.diskPath ?? diskPath());
  const onLog = options.onLog ?? (() => {});
  let lastPruneAt = Date.now();

  // ตัวอย่างแรกใช้เป็น baseline ของ CPU delta เท่านั้น (sample() คืน null) — ยิงทิ้งทันที
  // เพื่อให้รอบเก็บจริงรอบแรกมีค่า CPU ใช้ได้เลย ไม่ต้องรอครบสองรอบ
  await host.sample().catch(() => null);

  while (!signal.aborted) {
    await sleep(MONITORING.sampleIntervalMs, signal);
    if (signal.aborted) break;

    const ts = Date.now();

    try {
      const sample = await host.sample(ts);
      if (sample) insertHostSample(db, sample);
    } catch (err) {
      onLog(`เก็บ host metrics ไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const samples = await collectContainerSamples(docker);
      insertContainerSamples(db, ts, samples);
    } catch (err) {
      onLog(`เก็บ container metrics ไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (ts - lastPruneAt >= MONITORING.pruneIntervalMs) {
      lastPruneAt = ts;
      try {
        pruneMetrics(db, ts - MONITORING.retentionMs);
      } catch (err) {
        onLog(`prune metrics ไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
