import { describe, expect, test } from "bun:test";
import {
  assertTransition,
  canTransition,
  DEPLOYMENT_STATUSES,
  InvalidTransitionError,
  isTerminal,
} from "../src/deployment-state";

describe("deployment state machine", () => {
  test("happy path เดินหน้าตามลำดับได้ครบ", () => {
    const path = [
      "queued",
      "cloning",
      "building",
      "starting",
      "health_checking",
      "activating",
      "succeeded",
    ] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  test("ทุก non-terminal state ไป failed และ cancelled ได้", () => {
    for (const status of DEPLOYMENT_STATUSES) {
      if (isTerminal(status)) continue;
      expect(canTransition(status, "failed")).toBe(true);
      expect(canTransition(status, "cancelled")).toBe(true);
    }
  });

  test("ข้าม state ไม่ได้", () => {
    expect(canTransition("queued", "building")).toBe(false);
    expect(canTransition("cloning", "succeeded")).toBe(false);
    expect(canTransition("queued", "succeeded")).toBe(false);
  });

  test("ถอยหลังไม่ได้", () => {
    expect(canTransition("building", "cloning")).toBe(false);
    expect(canTransition("activating", "queued")).toBe(false);
  });

  test("terminal states ออกไปไหนไม่ได้", () => {
    for (const terminal of ["succeeded", "failed", "cancelled"] as const) {
      for (const to of DEPLOYMENT_STATUSES) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  test("assertTransition โยน InvalidTransitionError พร้อมรายละเอียด", () => {
    expect(() => assertTransition("queued", "succeeded")).toThrow(InvalidTransitionError);
    try {
      assertTransition("failed", "queued");
      expect.unreachable();
    } catch (e) {
      const err = e as InvalidTransitionError;
      expect(err.from).toBe("failed");
      expect(err.to).toBe("queued");
    }
  });
});
