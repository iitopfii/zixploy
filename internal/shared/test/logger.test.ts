import { describe, expect, test } from "bun:test";
import { createLogger, REDACTED, redact, redactString } from "../src/logger";

function capture(level?: "debug" | "info" | "warn" | "error") {
  const lines: string[] = [];
  const logger = createLogger({
    service: "test",
    ...(level ? { level } : {}),
    sink: (line) => lines.push(line),
  });
  return { logger, lines, parsed: () => lines.map((l) => JSON.parse(l)) };
}

describe("redact — sensitive keys", () => {
  test("ตัดค่าของ field ที่อ่อนไหวทุกชื่อที่ระบบใช้จริง", () => {
    const input = {
      password: "correct horse battery staple",
      passwordHash: "$argon2id$v=19$...",
      sessionToken: "abc123",
      csrfToken: "def456",
      cookie: "zx_session=xyz",
      authorization: "Bearer abc",
      apiKey: "k-123",
      privateKey: "-----BEGIN...",
      webhookSecret: "s3cret",
      username: "admin",
    };
    const out = redact(input) as Record<string, unknown>;

    for (const key of [
      "password",
      "passwordHash",
      "sessionToken",
      "csrfToken",
      "cookie",
      "authorization",
      "apiKey",
      "privateKey",
      "webhookSecret",
    ]) {
      expect(out[key]).toBe(REDACTED);
    }
    // field ที่ไม่อ่อนไหวต้องยังอยู่ครบ
    expect(out.username).toBe("admin");
  });

  test("ตัดใน nested object และ array ด้วย", () => {
    const out = redact({
      user: { name: "admin", password: "secret-value" },
      items: [{ token: "aaa" }, { name: "ok" }],
    }) as { user: Record<string, unknown>; items: Record<string, unknown>[] };

    expect(out.user.name).toBe("admin");
    expect(out.user.password).toBe(REDACTED);
    expect(out.items[0]?.token).toBe(REDACTED);
    expect(out.items[1]?.name).toBe("ok");
  });

  test("container ที่ชื่ออ่อนไหวถูกตัดทั้งก้อน ไม่ต้องไล่ดูข้างใน", () => {
    const out = redact({ sessions: [{ id: "a" }], credentials: { user: "x" } }) as Record<
      string,
      unknown
    >;
    expect(out.sessions).toBe(REDACTED);
    expect(out.credentials).toBe(REDACTED);
  });

  test("ไม่พังเมื่อเจอ circular reference", () => {
    const node: Record<string, unknown> = { name: "a" };
    node.self = node;
    expect(() => JSON.stringify(redact(node))).not.toThrow();
  });

  test("Error เก็บเฉพาะ name/message ไม่มี stack", () => {
    const out = redact(new Error("boom")) as Record<string, unknown>;
    expect(out).toEqual({ name: "Error", message: "boom" });
    expect(out.stack).toBeUndefined();
  });
});

describe("redactString — credential patterns", () => {
  test("ปิดบัง credential ใน URL", () => {
    const out = redactString("cloning https://x-access-token:ghs_secret123@github.com/o/r.git");
    expect(out).not.toContain("ghs_secret123");
    expect(out).toContain(REDACTED);
    expect(out).toContain("github.com/o/r.git");
  });

  test("ปิดบัง Bearer/Basic token", () => {
    expect(redactString("Authorization: Bearer abcdef1234567890")).not.toContain(
      "abcdef1234567890",
    );
    expect(redactString("Basic dXNlcjpwYXNzd29yZA==")).not.toContain("dXNlcjpwYXNzd29yZA");
  });

  test("ปิดบังค่าคุกกี้ของระบบ", () => {
    const out = redactString("cookie header: zx_session=tok123abc; zx_csrf=csrf456def");
    expect(out).not.toContain("tok123abc");
    expect(out).not.toContain("csrf456def");
    expect(out).toContain("zx_session=[redacted]");
    expect(out).toContain("zx_csrf=[redacted]");
  });
});

describe("createLogger", () => {
  test("เขียน JSON ที่มี level/service/message และ requestId", () => {
    const { logger, parsed } = capture();
    logger.info("project created", { requestId: "01ABC", projectId: "01XYZ" });

    expect(parsed()[0]).toEqual({
      level: "info",
      service: "test",
      message: "project created",
      requestId: "01ABC",
      projectId: "01XYZ",
    });
  });

  test("redact ทำงานทั้งใน fields และใน message", () => {
    const { logger, lines } = capture();
    logger.error("login failed for zx_session=leaked123", {
      password: "correct horse battery staple",
      requestId: "01ABC",
    });

    const line = lines[0] ?? "";
    expect(line).not.toContain("correct horse battery staple");
    expect(line).not.toContain("leaked123");
    expect(line).toContain("01ABC");
  });

  test("level ต่ำกว่าที่ตั้งไว้ไม่ถูกเขียน", () => {
    const { logger, lines } = capture("warn");
    logger.debug("noisy");
    logger.info("also noisy");
    logger.warn("important");
    logger.error("critical");
    expect(lines).toHaveLength(2);
  });

  test("debug mode ก็ยัง redact (ห้ามมีข้อยกเว้น)", () => {
    const { logger, lines } = capture("debug");
    logger.debug("dump", { cookie: "zx_session=abc", token: "t-1" });
    expect(lines[0]).not.toContain("zx_session=abc");
    expect(lines[0]).not.toContain("t-1");
  });
});
