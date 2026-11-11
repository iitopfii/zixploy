/**
 * buildCreateArgs — flag hardening ของ component (0.1.24) โดยไม่ต้องมี Docker daemon
 */

import { describe, expect, test } from "bun:test";
import { buildCreateArgs } from "../src/docker/cli-client";
import type { ContainerCreateParams } from "../src/docker/types";

const base: ContainerCreateParams = {
  name: "zx-test",
  image: "ghcr.io/acme/ocr:1",
  labels: {},
  restartPolicy: "unless-stopped",
  networkName: "zx-dnet-test",
};

/** ค่าที่ตามหลัง flag ทุกตัวที่ชื่อนี้ */
function valuesOf(args: string[], flag: string): string[] {
  return args.flatMap((a, i) => (a === flag ? [args[i + 1] ?? ""] : []));
}

describe("buildCreateArgs — hardening", () => {
  test("ไม่ตั้งอะไร → พฤติกรรมเดิม (pids 512, ไม่มี cap-drop/security-opt/memory-swap)", () => {
    const args = buildCreateArgs(base);
    expect(valuesOf(args, "--pids-limit")).toEqual(["512"]);
    expect(args).not.toContain("--cap-drop");
    expect(args).not.toContain("--security-opt");
    expect(args).not.toContain("--memory-swap");
    expect(args.at(-1)).toBe("ghcr.io/acme/ocr:1");
  });

  test("ตั้งครบ → cap-drop ALL, no-new-privileges, memory-swap, pids ตามที่ตั้ง", () => {
    const args = buildCreateArgs({
      ...base,
      memoryLimitMb: 3584,
      memorySwapMb: 3584,
      pidsLimit: 256,
      capDropAll: true,
      noNewPrivileges: true,
    });
    expect(valuesOf(args, "--cap-drop")).toEqual(["ALL"]);
    expect(valuesOf(args, "--security-opt")).toEqual(["no-new-privileges:true"]);
    expect(valuesOf(args, "--memory")).toEqual(["3584m"]);
    expect(valuesOf(args, "--memory-swap")).toEqual(["3584m"]);
    expect(valuesOf(args, "--pids-limit")).toEqual(["256"]);
  });

  test("memory-swap ไม่มี memory → ข้าม (Docker จะปฏิเสธทั้ง create)", () => {
    const args = buildCreateArgs({ ...base, memorySwapMb: 2048 });
    expect(args).not.toContain("--memory-swap");
  });

  test("image/cmd อยู่ท้ายหลัง flag ทั้งหมด", () => {
    const args = buildCreateArgs({ ...base, capDropAll: true, cmd: ["serve"] });
    expect(args.slice(-2)).toEqual(["ghcr.io/acme/ocr:1", "serve"]);
  });
});
