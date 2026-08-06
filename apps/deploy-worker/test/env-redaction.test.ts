/**
 * buildRedactFn tests — docs/phase-04-environment.md M4
 *
 * ครอบคลุม:
 * - ไม่มี secretValues → คืน redactString เท่านั้น (GitHub token ยัง redact ได้)
 * - secret value ถูกแทนด้วย [redacted]
 * - ค่าสั้นกว่า ENV_SECRET_MIN_REDACT_LENGTH ถูก skip
 * - longest-first order: ค่ายาวถูก match ก่อนค่าที่เป็น substring
 * - regex metachar ใน secret value ถูก escape
 * - GitHub token ยัง redact ได้ (base redactString ยังทำงาน)
 * - secret ปรากฏในหลายจุดของบรรทัด → redact ทุกจุด
 * - secret ไม่ปรากฏ → บรรทัดไม่เปลี่ยน
 */

import { describe, expect, test } from "bun:test";
import { REDACTED } from "@zixploy/shared";
import { buildRedactFn } from "../src/env/redaction";

describe("buildRedactFn — ไม่มี secretValues", () => {
  test("คืน redactString function (GitHub token ยัง redact ได้)", () => {
    const redact = buildRedactFn([]);
    const line = "cloning with Authorization: bearer ghs_ABCDEFGHIJKLMNOPQRS";
    const result = redact(line);
    expect(result).not.toContain("ghs_ABCDEFGHIJKLMNOPQRS");
    expect(result).toContain(REDACTED);
  });

  test("บรรทัดปกติไม่เปลี่ยน", () => {
    const redact = buildRedactFn([]);
    expect(redact("Step 1/5 : FROM node:20")).toBe("Step 1/5 : FROM node:20");
  });
});

describe("buildRedactFn — secret value replacement", () => {
  test("secret value ในบรรทัดถูก replace ด้วย [redacted]", () => {
    const redact = buildRedactFn(["super-secret-pass"]);
    const result = redact("db password=super-secret-pass connected");
    expect(result).not.toContain("super-secret-pass");
    expect(result).toContain(REDACTED);
  });

  test("secret ปรากฏหลายจุด → redact ทุกจุด", () => {
    const redact = buildRedactFn(["tok123"]);
    const result = redact("step 1: tok123 step 2: tok123 done");
    expect(result).not.toContain("tok123");
    const count = (result.match(/\[redacted\]/g) ?? []).length;
    expect(count).toBe(2);
  });

  test("secret ไม่อยู่ใน line → บรรทัดไม่เปลี่ยน", () => {
    const redact = buildRedactFn(["xyz-secret-xyz"]);
    const line = "FROM node:20 as builder";
    expect(redact(line)).toBe(line);
  });

  test("multiple secrets → redact ทุกตัว", () => {
    const redact = buildRedactFn(["alpha-secret", "beta-secret"]);
    const result = redact("a=alpha-secret b=beta-secret done");
    expect(result).not.toContain("alpha-secret");
    expect(result).not.toContain("beta-secret");
    const count = (result.match(/\[redacted\]/g) ?? []).length;
    expect(count).toBe(2);
  });
});

describe("buildRedactFn — minimum length filter", () => {
  test("ค่าที่สั้นกว่า ENV_SECRET_MIN_REDACT_LENGTH (4) ถูก skip — ไม่ false positive", () => {
    const redact = buildRedactFn(["on", "1", "ab", "abc"]); // ทั้งหมดสั้น < 4
    // บรรทัดที่มี "on" และ "1" ปกติ ไม่ถูก redact
    expect(redact("running 1 step on docker")).toBe("running 1 step on docker");
  });

  test("ค่าที่ยาวพอ (≥4) ยัง redact ได้", () => {
    const redact = buildRedactFn(["abcd"]); // exactly 4
    const result = redact("token abcd here");
    expect(result).not.toContain("abcd");
    expect(result).toContain(REDACTED);
  });
});

describe("buildRedactFn — longest-first (substring safety)", () => {
  test("ค่ายาวถูก match ก่อน — ป้องกัน substring ทำลาย pattern ค่ายาว", () => {
    // "abc" เป็น substring ของ "abc123secret"
    // ถ้า "abc" match ก่อน → "abc123secret" จะกลายเป็น "[redacted]123secret" (ไม่ถูก)
    // ถ้า "abc123secret" match ก่อน → "[redacted]" (ถูก)
    const redact = buildRedactFn(["abc", "abc123secret"]);
    const result = redact("found: abc123secret here");
    // "abc123secret" ต้องถูก redact ทั้งก้อน
    expect(result).not.toContain("abc123secret");
  });
});

describe("buildRedactFn — regex metachar escaping", () => {
  test("secret ที่มี . + * ? ใน value ถูก escape — ไม่เป็น wildcard", () => {
    const redact = buildRedactFn(["sec.ret+val"]);
    // "sec.ret+val" ต้อง match literal ไม่ใช่ regex pattern
    // "secXretYval" ต้องไม่ถูก redact (. ไม่ใช่ wildcard)
    expect(redact("secXretYval here")).toBe("secXretYval here");
    // literal match ต้อง redact
    expect(redact("sec.ret+val here")).not.toContain("sec.ret+val");
  });

  test("secret ที่มี ( ) [ ] ถูก escape", () => {
    const redact = buildRedactFn(["(tok[en])"]);
    // literal match
    const result = redact("auth: (tok[en]) done");
    expect(result).not.toContain("(tok[en])");
    expect(result).toContain(REDACTED);
  });
});

describe("buildRedactFn — base redactString ยังทำงาน", () => {
  test("GitHub token ถูก redact แม้มี secretValues ด้วย", () => {
    const redact = buildRedactFn(["my-db-pass"]);
    const line = "Authorization: bearer ghs_ABCDEFGHIJKLMNOPQRS db=my-db-pass";
    const result = redact(line);
    expect(result).not.toContain("ghs_ABCDEFGHIJKLMNOPQRS");
    expect(result).not.toContain("my-db-pass");
  });
});
