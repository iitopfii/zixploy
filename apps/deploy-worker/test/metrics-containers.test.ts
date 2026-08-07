/**
 * Container metrics tests — Phase 9 M2
 *
 * ใช้ fake DockerCliClient ทั้งหมด ไม่ต้องมี Docker daemon จริง
 */

import { describe, expect, test } from "bun:test";
import { LABELS } from "@zixploy/shared";
import type { DockerCliClient } from "../src/docker/cli-client";
import type { ContainerInspect, ContainerSummary, DockerStatsEntry } from "../src/docker/types";
import {
  collectContainerSamples,
  parseBytes,
  parseMemUsage,
  parsePercent,
  pickPerProject,
} from "../src/metrics/containers";

// ---------------------------------------------------------------------------
// parsers
// ---------------------------------------------------------------------------

describe("parsePercent", () => {
  test("'0.05%' → 0.05", () => {
    expect(parsePercent("0.05%")).toBeCloseTo(0.05);
  });

  test("'123.45%' → 123.45 (container ใช้เกิน 1 core ได้จริง)", () => {
    expect(parsePercent("123.45%")).toBeCloseTo(123.45);
  });

  test("'--' (container หยุดแล้ว) → null", () => {
    expect(parsePercent("--")).toBeNull();
  });

  test("ไม่มี % → null", () => {
    expect(parsePercent("12")).toBeNull();
  });
});

describe("parseBytes", () => {
  test("หน่วยฐาน 1024 (KiB/MiB/GiB)", () => {
    expect(parseBytes("1KiB")).toBe(1024);
    expect(parseBytes("2MiB")).toBe(2 * 1024 ** 2);
    expect(parseBytes("1.5GiB")).toBe(Math.round(1.5 * 1024 ** 3));
  });

  test("หน่วยฐาน 1000 (kB/MB/GB)", () => {
    expect(parseBytes("1kB")).toBe(1000);
    expect(parseBytes("2MB")).toBe(2_000_000);
  });

  test("'0B' → 0", () => {
    expect(parseBytes("0B")).toBe(0);
  });

  test("มีช่องว่างคั่น → parse ได้", () => {
    expect(parseBytes("19.3 MiB")).toBe(Math.round(19.3 * 1024 ** 2));
  });

  test("หน่วยที่ไม่รู้จัก → null", () => {
    expect(parseBytes("5parsecs")).toBeNull();
  });

  test("'--' → null", () => {
    expect(parseBytes("--")).toBeNull();
  });
});

describe("parseMemUsage", () => {
  test("'19.3MiB / 7.772GiB' → used/limit", () => {
    const mem = parseMemUsage("19.3MiB / 7.772GiB");
    expect(mem?.usedBytes).toBe(Math.round(19.3 * 1024 ** 2));
    expect(mem?.limitBytes).toBe(Math.round(7.772 * 1024 ** 3));
  });

  test("ไม่มีตัวคั่น '/' → null", () => {
    expect(parseMemUsage("19.3MiB")).toBeNull();
  });

  test("ฝั่งใดฝั่งหนึ่ง parse ไม่ได้ → null", () => {
    expect(parseMemUsage("-- / --")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pickPerProject
// ---------------------------------------------------------------------------

describe("pickPerProject", () => {
  test("project เดียว container เดียว → เลือกตัวนั้น", () => {
    const chosen = pickPerProject([{ projectId: "p1", containerId: "c1" }], new Set(["c1"]));
    expect(chosen.get("p1")).toBe("c1");
  });

  test("มีทั้ง running และ exited → เลือกตัวที่ running แม้จะเจอทีหลัง", () => {
    const chosen = pickPerProject(
      [
        { projectId: "p1", containerId: "old-exited" },
        { projectId: "p1", containerId: "new-running" },
      ],
      new Set(["new-running"]),
    );
    expect(chosen.get("p1")).toBe("new-running");
  });

  test("ไม่มีตัวไหน running → เลือกตัวแรก (docker ps เรียงใหม่→เก่า)", () => {
    const chosen = pickPerProject(
      [
        { projectId: "p1", containerId: "newest" },
        { projectId: "p1", containerId: "older" },
      ],
      new Set(),
    );
    expect(chosen.get("p1")).toBe("newest");
  });

  test("running อยู่แล้วไม่ถูกแทนที่ด้วยตัว exited ที่เจอทีหลัง", () => {
    const chosen = pickPerProject(
      [
        { projectId: "p1", containerId: "running-one" },
        { projectId: "p1", containerId: "exited-one" },
      ],
      new Set(["running-one"]),
    );
    expect(chosen.get("p1")).toBe("running-one");
  });

  test("หลาย project แยกกันอิสระ", () => {
    const chosen = pickPerProject(
      [
        { projectId: "p1", containerId: "c1" },
        { projectId: "p2", containerId: "c2" },
      ],
      new Set(["c1", "c2"]),
    );
    expect(chosen.size).toBe(2);
    expect(chosen.get("p2")).toBe("c2");
  });
});

// ---------------------------------------------------------------------------
// collectContainerSamples
// ---------------------------------------------------------------------------

function summary(id: string, projectId: string): ContainerSummary {
  return {
    ID: id,
    Names: `zx-${id}`,
    Image: "img:tag",
    Labels: `${LABELS.managed}=true,${LABELS.projectId}=${projectId}`,
  };
}

function inspect(
  id: string,
  opts: Partial<{ running: boolean; restarts: number; memory: number }> = {},
): ContainerInspect {
  return {
    Id: id,
    Name: `/zx-${id}`,
    State: {
      Status: opts.running === false ? "exited" : "running",
      Running: opts.running !== false,
    },
    RestartCount: opts.restarts ?? 0,
    NetworkSettings: { Networks: {} },
    HostConfig: { Memory: opts.memory ?? 0 },
  };
}

function stat(id: string, cpu: string, mem: string): DockerStatsEntry {
  return {
    ID: id,
    Name: `zx-${id}`,
    CPUPerc: cpu,
    MemUsage: mem,
    MemPerc: "1%",
    NetIO: "0B / 0B",
    BlockIO: "0B / 0B",
    PIDs: "5",
  };
}

/** DockerCliClient ปลอมที่ตอบเฉพาะ 3 method ที่ collector ใช้ */
function fakeDocker(opts: {
  containers?: ContainerSummary[];
  inspects?: ContainerInspect[];
  stats?: DockerStatsEntry[];
  listThrows?: boolean;
}): DockerCliClient {
  return {
    listContainersByLabel: async () => {
      if (opts.listThrows) throw new Error("daemon down");
      return opts.containers ?? [];
    },
    inspectContainers: async () => opts.inspects ?? [],
    statsByIds: async () => opts.stats ?? [],
  } as unknown as DockerCliClient;
}

describe("collectContainerSamples", () => {
  test("เก็บค่าจาก stats + inspect ครบถ้วน", async () => {
    const samples = await collectContainerSamples(
      fakeDocker({
        containers: [summary("c1", "p1")],
        inspects: [inspect("c1", { restarts: 3, memory: 512 * 1024 ** 2 })],
        stats: [stat("c1", "12.5%", "100MiB / 2GiB")],
      }),
    );

    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      projectId: "p1",
      containerId: "c1",
      restartCount: 3,
      running: true,
      memLimitBytes: 512 * 1024 ** 2,
    });
    expect(samples[0]?.cpuPercent).toBeCloseTo(12.5);
    expect(samples[0]?.memUsedBytes).toBe(100 * 1024 ** 2);
  });

  test("memory limit มาจาก HostConfig.Memory ไม่ใช่จาก stats", async () => {
    // stats บอก limit = 2GiB (ขนาด RAM เครื่อง) แต่ container ไม่ได้ตั้ง limit จริง
    const samples = await collectContainerSamples(
      fakeDocker({
        containers: [summary("c1", "p1")],
        inspects: [inspect("c1", { memory: 0 })],
        stats: [stat("c1", "1%", "100MiB / 2GiB")],
      }),
    );
    expect(samples[0]?.memLimitBytes).toBe(0);
  });

  test("container ที่ไม่มี project_id label ถูกข้าม (orphan)", async () => {
    const orphan: ContainerSummary = {
      ID: "orphan",
      Names: "x",
      Image: "i",
      Labels: `${LABELS.managed}=true`,
    };
    const samples = await collectContainerSamples(
      fakeDocker({ containers: [orphan], inspects: [inspect("orphan")], stats: [] }),
    );
    expect(samples).toHaveLength(0);
  });

  test("container ที่หยุดแล้วถูกเก็บด้วย running=0 และค่าเป็น 0", async () => {
    const samples = await collectContainerSamples(
      fakeDocker({
        containers: [summary("c1", "p1")],
        inspects: [inspect("c1", { running: false, restarts: 7 })],
        stats: [], // stats ไม่คืนอะไรเพราะไม่ running
      }),
    );

    expect(samples).toHaveLength(1);
    expect(samples[0]?.running).toBe(false);
    expect(samples[0]?.cpuPercent).toBe(0);
    expect(samples[0]?.restartCount).toBe(7);
  });

  test("running แต่ stats ไม่คืนค่า → ข้ามไป (ไม่เก็บ 0% ที่อ่านเหมือนว่างสนิท)", async () => {
    const samples = await collectContainerSamples(
      fakeDocker({
        containers: [summary("c1", "p1")],
        inspects: [inspect("c1", { running: true })],
        stats: [],
      }),
    );
    expect(samples).toHaveLength(0);
  });

  test("จับคู่ ID สั้น 12 ตัวจาก docker ps กับ Id เต็มจาก inspect ได้", async () => {
    const shortId = "abcdef123456";
    const fullId = `${shortId}7890abcdef1234567890abcdef1234567890abcdef1234567890`;
    const samples = await collectContainerSamples(
      fakeDocker({
        containers: [summary(shortId, "p1")],
        inspects: [inspect(fullId, { restarts: 2 })],
        stats: [stat(shortId, "5%", "10MiB / 1GiB")],
      }),
    );

    expect(samples).toHaveLength(1);
    expect(samples[0]?.restartCount).toBe(2);
  });

  test("docker ps ล้มเหลว → คืน [] ไม่ throw", async () => {
    const samples = await collectContainerSamples(fakeDocker({ listThrows: true }));
    expect(samples).toEqual([]);
  });

  test("ไม่มี container เลย → คืน [] โดยไม่เรียก inspect/stats", async () => {
    const samples = await collectContainerSamples(fakeDocker({ containers: [] }));
    expect(samples).toEqual([]);
  });

  test("หนึ่ง project มีหลาย container → เก็บแค่ตัวที่ running ตัวเดียว", async () => {
    const samples = await collectContainerSamples(
      fakeDocker({
        containers: [summary("old", "p1"), summary("new", "p1")],
        inspects: [inspect("old", { running: false }), inspect("new", { running: true })],
        stats: [stat("new", "9%", "50MiB / 1GiB")],
      }),
    );

    expect(samples).toHaveLength(1);
    expect(samples[0]?.containerId).toBe("new");
  });
});
