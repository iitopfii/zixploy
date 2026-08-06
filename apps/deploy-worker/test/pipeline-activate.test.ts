/**
 * Unit tests สำหรับ activate.ts และ health-check.ts โดยตรง (ไม่ผ่าน build.ts)
 * — mock DockerCliClient ขั้นต่ำเฉพาะ method ที่ใช้จริง
 */
import { describe, expect, test } from "bun:test";
import { AppError } from "@zixploy/shared";
import { activate } from "../src/pipeline/activate";
import { waitForHealthy } from "../src/pipeline/health-check";

function mockDocker(overrides: Record<string, unknown> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, impl: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return impl(...args);
    };
  return {
    calls,
    stopContainer: record("stopContainer", async () => undefined),
    removeContainer: record("removeContainer", async () => undefined),
    inspectContainer: record("inspectContainer", async () => ({
      Id: "c1",
      Name: "/test",
      State: { Status: "running", Running: true },
      RestartCount: 0,
      NetworkSettings: { Networks: {} },
    })),
    ...overrides,
  };
}

describe("activate — ADR-0004 start-before-stop", () => {
  test("ไม่มี oldContainerId (deploy ครั้งแรก) → ไม่เรียก docker เลย", async () => {
    const docker = mockDocker();
    await activate({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      docker: docker as any,
      oldContainerId: null,
      drainMs: 0,
    });
    expect(docker.calls.length).toBe(0);
  });

  test("มี oldContainerId → รอ drain แล้ว stop ก่อน remove ตามลำดับ", async () => {
    const docker = mockDocker();
    await activate({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      docker: docker as any,
      oldContainerId: "old-c1",
      drainMs: 0,
    });
    expect(docker.calls.map((c) => c.method)).toEqual(["stopContainer", "removeContainer"]);
    expect(docker.calls[0]?.args[0]).toBe("old-c1");
    expect(docker.calls[1]?.args[0]).toBe("old-c1");
  });

  test("drainMs default คือ 5000ms ถ้าไม่ระบุ (ตรวจผ่านเวลาที่ผ่านไปจริง แบบย่อด้วย drainMs=20)", async () => {
    const docker = mockDocker();
    const start = performance.now();
    await activate({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      docker: docker as any,
      oldContainerId: "old-c1",
      drainMs: 20,
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(15);
  });
});

describe("waitForHealthy — fallback (ไม่มี health check path)", () => {
  test("container Running ครั้งแรก → healthy ทันที ไม่ poll ซ้ำ", async () => {
    const docker = mockDocker();
    await waitForHealthy({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      docker: docker as any,
      containerId: "c1",
      networkName: "zixploy-proxy",
      internalPort: null,
      healthCheckPath: null,
      intervalSec: 1,
      timeoutSec: 1,
      retries: 3,
      signal: new AbortController().signal,
    });
    expect(docker.calls.filter((c) => c.method === "inspectContainer").length).toBe(1);
  });

  test("container ยังไม่ Running รอบแรก แล้ว Running รอบสอง → รอแล้วผ่าน", async () => {
    let call = 0;
    const docker = mockDocker({
      inspectContainer: async () => {
        call++;
        return {
          Id: "c1",
          Name: "/test",
          State: { Status: call === 1 ? "created" : "running", Running: call !== 1 },
          RestartCount: 0,
          NetworkSettings: { Networks: {} },
        };
      },
    });
    await waitForHealthy({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      docker: docker as any,
      containerId: "c1",
      networkName: "zixploy-proxy",
      internalPort: null,
      healthCheckPath: null,
      intervalSec: 0.01,
      timeoutSec: 1,
      retries: 3,
      signal: new AbortController().signal,
    });
    expect(call).toBe(2);
  });

  test("container หายไป (inspectContainer คืน null) → HEALTH_CHECK_FAILED", async () => {
    const docker = mockDocker({ inspectContainer: async () => null });
    await expect(
      waitForHealthy({
        // biome-ignore lint/suspicious/noExplicitAny: mock
        docker: docker as any,
        containerId: "c1",
        networkName: "zixploy-proxy",
        internalPort: null,
        healthCheckPath: null,
        intervalSec: 0.01,
        timeoutSec: 1,
        retries: 2,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(AppError);
  });

  test("หมด retries โดยไม่เคย Running → HEALTH_CHECK_FAILED", async () => {
    const docker = mockDocker({
      inspectContainer: async () => ({
        Id: "c1",
        Name: "/test",
        State: { Status: "created", Running: false },
        RestartCount: 0,
        NetworkSettings: { Networks: {} },
      }),
    });
    let err: unknown;
    try {
      await waitForHealthy({
        // biome-ignore lint/suspicious/noExplicitAny: mock
        docker: docker as any,
        containerId: "c1",
        networkName: "zixploy-proxy",
        internalPort: null,
        healthCheckPath: null,
        intervalSec: 0.01,
        timeoutSec: 1,
        retries: 2,
        signal: new AbortController().signal,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("HEALTH_CHECK_FAILED");
  });
});

describe("waitForHealthy — HTTP probe (internalPort + healthCheckPath ตั้งไว้)", () => {
  test("probe สำเร็จ (2xx) → healthy ทันที", async () => {
    const docker = mockDocker({
      inspectContainer: async () => ({
        Id: "c1",
        Name: "/test",
        State: { Status: "running", Running: true },
        RestartCount: 0,
        NetworkSettings: { Networks: { "zixploy-proxy": { IPAddress: "172.20.0.5" } } },
      }),
    });
    const captured: { fetchCalledWith: string | null } = { fetchCalledWith: null };
    const fetchFn = (async (url: string) => {
      captured.fetchCalledWith = url;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    await waitForHealthy({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      docker: docker as any,
      containerId: "c1",
      networkName: "zixploy-proxy",
      internalPort: 3000,
      healthCheckPath: "/healthz",
      intervalSec: 0.01,
      timeoutSec: 1,
      retries: 3,
      signal: new AbortController().signal,
      fetchFn,
    });

    expect(captured.fetchCalledWith).toBe("http://172.20.0.5:3000/healthz");
  });

  test("probe คืน 500 ซ้ำจนหมด retries → HEALTH_CHECK_FAILED", async () => {
    const docker = mockDocker({
      inspectContainer: async () => ({
        Id: "c1",
        Name: "/test",
        State: { Status: "running", Running: true },
        RestartCount: 0,
        NetworkSettings: { Networks: { "zixploy-proxy": { IPAddress: "172.20.0.5" } } },
      }),
    });
    const fetchFn = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;

    await expect(
      waitForHealthy({
        // biome-ignore lint/suspicious/noExplicitAny: mock
        docker: docker as any,
        containerId: "c1",
        networkName: "zixploy-proxy",
        internalPort: 3000,
        healthCheckPath: "/healthz",
        intervalSec: 0.01,
        timeoutSec: 1,
        retries: 2,
        signal: new AbortController().signal,
        fetchFn,
      }),
    ).rejects.toThrow(AppError);
  });

  test("probe throw (connection refused) ซ้ำจนหมด retries → HEALTH_CHECK_FAILED (ไม่ crash)", async () => {
    const docker = mockDocker({
      inspectContainer: async () => ({
        Id: "c1",
        Name: "/test",
        State: { Status: "running", Running: true },
        RestartCount: 0,
        NetworkSettings: { Networks: { "zixploy-proxy": { IPAddress: "172.20.0.5" } } },
      }),
    });
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(
      waitForHealthy({
        // biome-ignore lint/suspicious/noExplicitAny: mock
        docker: docker as any,
        containerId: "c1",
        networkName: "zixploy-proxy",
        internalPort: 3000,
        healthCheckPath: "/healthz",
        intervalSec: 0.01,
        timeoutSec: 1,
        retries: 2,
        signal: new AbortController().signal,
        fetchFn,
      }),
    ).rejects.toThrow(AppError);
  });

  test("ip ยังไม่ตั้งค่าใน network (NetworkSettings ว่าง) → ข้าม probe รอบนั้นไปรอต่อ", async () => {
    let call = 0;
    const docker = mockDocker({
      inspectContainer: async () => {
        call++;
        return {
          Id: "c1",
          Name: "/test",
          State: { Status: "running", Running: true },
          RestartCount: 0,
          NetworkSettings: {
            Networks: call === 1 ? {} : { "zixploy-proxy": { IPAddress: "172.20.0.9" } },
          },
        };
      },
    });
    let fetchCalls = 0;
    const fetchFn = (async () => {
      fetchCalls++;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    await waitForHealthy({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      docker: docker as any,
      containerId: "c1",
      networkName: "zixploy-proxy",
      internalPort: 3000,
      healthCheckPath: "/healthz",
      intervalSec: 0.01,
      timeoutSec: 1,
      retries: 3,
      signal: new AbortController().signal,
      fetchFn,
    });

    expect(call).toBe(2);
    expect(fetchCalls).toBe(1);
  });
});

describe("waitForHealthy — crash-loop detection", () => {
  test("RestartCount ถึง threshold (3) → CONTAINER_CRASH_LOOP ทันที ไม่รอครบ retries", async () => {
    let call = 0;
    const docker = mockDocker({
      inspectContainer: async () => {
        call++;
        return {
          Id: "c1",
          Name: "/test",
          State: { Status: "running", Running: true },
          RestartCount: 3,
          NetworkSettings: { Networks: {} },
        };
      },
    });

    let err: unknown;
    try {
      await waitForHealthy({
        // biome-ignore lint/suspicious/noExplicitAny: mock
        docker: docker as any,
        containerId: "c1",
        networkName: "zixploy-proxy",
        internalPort: null,
        healthCheckPath: null,
        intervalSec: 0.01,
        timeoutSec: 1,
        retries: 10,
        signal: new AbortController().signal,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("CONTAINER_CRASH_LOOP");
    // fail เร็วตั้งแต่รอบแรก ไม่รอครบ 10 retries
    expect(call).toBe(1);
  });

  test("RestartCount ต่ำกว่า threshold → ไม่ trigger crash-loop", async () => {
    const docker = mockDocker({
      inspectContainer: async () => ({
        Id: "c1",
        Name: "/test",
        State: { Status: "running", Running: true },
        RestartCount: 2,
        NetworkSettings: { Networks: {} },
      }),
    });

    await waitForHealthy({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      docker: docker as any,
      containerId: "c1",
      networkName: "zixploy-proxy",
      internalPort: null,
      healthCheckPath: null,
      intervalSec: 0.01,
      timeoutSec: 1,
      retries: 3,
      signal: new AbortController().signal,
    });
    // ไม่ throw = pass
  });
});

describe("waitForHealthy — cancellation", () => {
  test("signal ถูก abort ก่อนเริ่ม → HEALTH_CHECK_FAILED ทันที", async () => {
    const docker = mockDocker();
    const controller = new AbortController();
    controller.abort();

    let err: unknown;
    try {
      await waitForHealthy({
        // biome-ignore lint/suspicious/noExplicitAny: mock
        docker: docker as any,
        containerId: "c1",
        networkName: "zixploy-proxy",
        internalPort: null,
        healthCheckPath: null,
        intervalSec: 1,
        timeoutSec: 1,
        retries: 5,
        signal: controller.signal,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("HEALTH_CHECK_FAILED");
    expect(docker.calls.length).toBe(0);
  });
});
