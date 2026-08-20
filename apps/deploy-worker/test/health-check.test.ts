/**
 * waitForHealthy — unit tests
 *
 * โฟกัสที่ stability gate ของ fallback แบบไม่มี HTTP check (แก้จากเหตุการณ์จริง 2026-08-20:
 * container ที่ start ติดแล้ว crash ใน 2-3 วิ ถูกนับเป็น deploy สำเร็จ เพราะเดิมเช็ค Running
 * ครั้งเดียวแล้วผ่านเลย) — ต้องเห็น Running ต่อเนื่องตลอด window ถึงนับว่า healthy
 *
 * docker ถูก mock ด้วย state ตามลำดับ (ตัวสุดท้ายซ้ำไปเรื่อย ๆ) — ไม่ต้องมี Docker จริง
 * window/probe ย่นเหลือหลัก ms ผ่าน stabilityWindowMs/stabilityProbeMs ที่ฉีดได้
 */

import { describe, expect, test } from "bun:test";
import { AppError, type ErrorCode } from "@zixploy/shared";
import type { DockerCliClient } from "../src/docker/cli-client";
import type { HealthCheckParams } from "../src/pipeline/health-check";
import { waitForHealthy } from "../src/pipeline/health-check";

interface FakeState {
  running: boolean;
  restartCount: number;
  /** IP บน network (สำหรับ HTTP path) — default ไม่มี */
  ip?: string;
}

/** docker mock ที่คืน state ตามลำดับ — เกินลำดับแล้วคืนตัวสุดท้ายซ้ำ, null = container หาย */
function scriptedDocker(states: Array<FakeState | null>) {
  let i = 0;
  const inspectCalls = () => i;
  const docker = {
    inspectContainer: async () => {
      const s = states[Math.min(i, states.length - 1)] ?? null;
      i++;
      if (s === null) return null;
      return {
        Id: "c1",
        Name: "/test",
        State: { Status: s.running ? "running" : "exited", Running: s.running },
        RestartCount: s.restartCount,
        NetworkSettings: {
          Networks: s.ip ? { "zixploy-proxy": { IPAddress: s.ip } } : {},
        },
      };
    },
  } as unknown as DockerCliClient;
  return { docker, inspectCalls };
}

function baseParams(
  docker: DockerCliClient,
  overrides: Partial<HealthCheckParams> = {},
): HealthCheckParams {
  return {
    docker,
    containerId: "c1",
    networkName: "zixploy-proxy",
    internalPort: null,
    healthCheckPath: null,
    intervalSec: 0.001,
    timeoutSec: 1,
    retries: 3,
    signal: new AbortController().signal,
    stabilityWindowMs: 40,
    stabilityProbeMs: 5,
    ...overrides,
  };
}

async function expectAppError(promise: Promise<unknown>, code: ErrorCode): Promise<AppError> {
  const err = await promise.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  return err as AppError;
}

describe("waitForHealthy — ไม่มี health check path (stability gate)", () => {
  test("Running ต่อเนื่องตลอด window → สำเร็จ และ inspect มากกว่า 1 ครั้ง (ไม่ใช่เช็คครั้งเดียวแบบเดิม)", async () => {
    const { docker, inspectCalls } = scriptedDocker([{ running: true, restartCount: 0 }]);
    await waitForHealthy(baseParams(docker));
    expect(inspectCalls()).toBeGreaterThan(1);
  });

  test("container หยุดทำงานกลาง window → HEALTH_CHECK_FAILED", async () => {
    const { docker } = scriptedDocker([
      { running: true, restartCount: 0 },
      { running: false, restartCount: 0 },
    ]);
    const err = await expectAppError(waitForHealthy(baseParams(docker)), "HEALTH_CHECK_FAILED");
    expect(err.message).toContain("หยุดทำงานหลัง start");
  });

  test("RestartCount ขยับระหว่าง window (crash แล้วถูก restart) → CONTAINER_CRASH_LOOP", async () => {
    const { docker } = scriptedDocker([
      { running: true, restartCount: 0 },
      { running: true, restartCount: 1 },
    ]);
    await expectAppError(waitForHealthy(baseParams(docker)), "CONTAINER_CRASH_LOOP");
  });

  test("crash ทันทีตั้งแต่ inspect แรก (RestartCount 1) → CONTAINER_CRASH_LOOP ไม่รอครบ window", async () => {
    const { docker, inspectCalls } = scriptedDocker([{ running: true, restartCount: 1 }]);
    await expectAppError(waitForHealthy(baseParams(docker)), "CONTAINER_CRASH_LOOP");
    expect(inspectCalls()).toBe(1);
  });

  test("container หายไป → HEALTH_CHECK_FAILED", async () => {
    const { docker } = scriptedDocker([{ running: true, restartCount: 0 }, null]);
    await expectAppError(waitForHealthy(baseParams(docker)), "HEALTH_CHECK_FAILED");
  });

  test("log บอกว่ากำลังเฝ้าดู + แนะนำให้ตั้ง health check path", async () => {
    const { docker } = scriptedDocker([{ running: true, restartCount: 0 }]);
    const logged: string[] = [];
    await waitForHealthy(baseParams(docker, { onLog: (l) => logged.push(l) }));
    expect(logged.some((l) => l.includes("เฝ้าดู container"))).toBe(true);
  });
});

describe("waitForHealthy — HTTP check path (พฤติกรรมเดิมต้องไม่เปลี่ยน)", () => {
  test("probe ตอบ 200 → สำเร็จทันทีโดยไม่ต้องรอ stability window", async () => {
    const { docker, inspectCalls } = scriptedDocker([
      { running: true, restartCount: 0, ip: "172.18.0.5" },
    ]);
    const fetchFn = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    await waitForHealthy(
      baseParams(docker, { internalPort: 3000, healthCheckPath: "/healthz", fetchFn }),
    );
    expect(inspectCalls()).toBe(1);
  });

  test("probe ไม่ผ่านจนหมด retries → HEALTH_CHECK_FAILED", async () => {
    const { docker } = scriptedDocker([{ running: true, restartCount: 0, ip: "172.18.0.5" }]);
    const fetchFn = (async () => new Response("bad", { status: 500 })) as unknown as typeof fetch;
    await expectAppError(
      waitForHealthy(
        baseParams(docker, {
          internalPort: 3000,
          healthCheckPath: "/healthz",
          fetchFn,
          retries: 2,
        }),
      ),
      "HEALTH_CHECK_FAILED",
    );
  });

  test("RestartCount ถึง threshold ระหว่าง HTTP check → CONTAINER_CRASH_LOOP", async () => {
    const { docker } = scriptedDocker([{ running: true, restartCount: 3, ip: "172.18.0.5" }]);
    const fetchFn = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    await expectAppError(
      waitForHealthy(
        baseParams(docker, { internalPort: 3000, healthCheckPath: "/healthz", fetchFn }),
      ),
      "CONTAINER_CRASH_LOOP",
    );
  });
});
