import { describe, expect, test } from "bun:test";
import { isGitBranchName, isRepoFullName } from "../src";

describe("isRepoFullName", () => {
  test("รับ owner/repo ปกติ", () => {
    expect(isRepoFullName("hype-developer/sealand-backend")).toBe(true);
    expect(isRepoFullName("acme/app.web_v2")).toBe(true);
  });
  test("ปฏิเสธรูปแบบอื่น", () => {
    for (const bad of [
      "acme",
      "acme/",
      "/repo",
      "acme/re po",
      "-acme/repo",
      "a/b/c",
      "acme/..",
      "acme/.",
    ]) {
      expect(isRepoFullName(bad)).toBe(false);
    }
  });
});

describe("isGitBranchName", () => {
  test("รับชื่อ branch ปกติ", () => {
    for (const ok of ["main", "uat", "feat/SEALAND-754-web-deploy", "release/1.2.3", "v1"]) {
      expect(isGitBranchName(ok)).toBe(true);
    }
  });
  test("ปฏิเสธชื่อที่กลายเป็น flag หรือผิดกฎ ref", () => {
    for (const bad of [
      "",
      "-upload-pack=x",
      "a..b",
      "a b",
      "a~1",
      "a^",
      "a:b",
      "x.lock",
      "a/",
      "/a",
      "a//b",
      "a/.b",
      "a@{1}",
      "a\nb",
      "a*",
    ]) {
      expect(isGitBranchName(bad)).toBe(false);
    }
  });
});
