import { describe, expect, test } from "bun:test";
import { parseDeployPayload } from "../src/pipeline/payload";

describe("parseDeployPayload", () => {
  test("build payload ผ่านการ parse ปกติ", () => {
    const payload = parseDeployPayload({
      kind: "build",
      trigger: "push",
      commitSha: "a".repeat(40),
      commitMessage: "msg",
      commitAuthor: "author",
      installationId: 1,
      repoFullName: "org/repo",
    });
    expect(payload.kind).toBe("build");
  });

  test("rollback payload ผ่านการ parse ปกติ", () => {
    const payload = parseDeployPayload({
      kind: "rollback",
      targetDeploymentId: "01J000000000000000000000000",
      imageTag: "zixploy/x:tag",
      imageDigest: "sha256:abc",
    });
    expect(payload.kind).toBe("rollback");
  });

  test("restart/stop payload ผ่านการ parse ปกติ", () => {
    expect(parseDeployPayload({ kind: "restart" }).kind).toBe("restart");
    expect(parseDeployPayload({ kind: "stop" }).kind).toBe("stop");
  });

  test("null/undefined → throw", () => {
    expect(() => parseDeployPayload(null)).toThrow();
    expect(() => parseDeployPayload(undefined)).toThrow();
  });

  test("ไม่ใช่ object (string/number) → throw", () => {
    expect(() => parseDeployPayload("build")).toThrow();
    expect(() => parseDeployPayload(42)).toThrow();
  });

  test("ขาด field 'kind' → throw", () => {
    expect(() => parseDeployPayload({ trigger: "push" })).toThrow(/kind/);
  });

  test("kind ไม่รู้จัก → throw", () => {
    expect(() => parseDeployPayload({ kind: "explode" })).toThrow(/ไม่รู้จัก/);
  });
});
