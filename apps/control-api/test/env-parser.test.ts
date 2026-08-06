/**
 * .env parser tests — docs/phase-04-environment.md
 * ครอบคลุม: quote styles, comments, duplicates, multiline, export prefix, invalid keys
 */

import { describe, expect, test } from "bun:test";
import { parseEnvContent } from "../src/env/parser";

describe(".env parser — basic forms", () => {
  test("KEY=VALUE unquoted", () => {
    const { vars, warnings } = parseEnvContent("DATABASE_URL=postgres://localhost/db");
    expect(vars).toHaveLength(1);
    expect(vars[0]).toMatchObject({ key: "DATABASE_URL", value: "postgres://localhost/db" });
    expect(warnings).toHaveLength(0);
  });

  test('KEY="VALUE" double-quoted', () => {
    const { vars } = parseEnvContent('API_KEY="abc123"');
    expect(vars[0]).toMatchObject({ key: "API_KEY", value: "abc123" });
  });

  test("KEY='VALUE' single-quoted", () => {
    const { vars } = parseEnvContent("GREETING='hello world'");
    expect(vars[0]).toMatchObject({ key: "GREETING", value: "hello world" });
  });

  test("empty value → empty string", () => {
    const { vars } = parseEnvContent("EMPTY=");
    expect(vars[0]).toMatchObject({ key: "EMPTY", value: "" });
  });

  test("export prefix stripped", () => {
    const { vars } = parseEnvContent("export FOO=bar");
    expect(vars[0]).toMatchObject({ key: "FOO", value: "bar" });
  });

  test("multiple vars on separate lines", () => {
    const { vars } = parseEnvContent("A=1\nB=2\nC=3");
    expect(vars).toHaveLength(3);
    expect(vars.map((v) => v.key)).toEqual(["A", "B", "C"]);
  });

  test("line number recorded correctly", () => {
    const { vars } = parseEnvContent("\n\nFOO=bar\n\nBAZ=qux");
    expect(vars[0]?.lineNumber).toBe(3);
    expect(vars[1]?.lineNumber).toBe(5);
  });
});

describe(".env parser — comments and blank lines", () => {
  test("full-line comment skipped", () => {
    const { vars } = parseEnvContent("# this is a comment\nFOO=bar");
    expect(vars).toHaveLength(1);
    expect(vars[0]?.key).toBe("FOO");
  });

  test("blank lines skipped", () => {
    const { vars } = parseEnvContent("\n\n\nFOO=bar\n\n");
    expect(vars).toHaveLength(1);
  });

  test("inline comment stripped from unquoted value", () => {
    const { vars } = parseEnvContent("PORT=3000 # api port");
    expect(vars[0]?.value).toBe("3000");
  });

  test("# inside double-quoted value preserved", () => {
    const { vars } = parseEnvContent('HASH="sha256#abc"');
    expect(vars[0]?.value).toBe("sha256#abc");
  });

  test("# inside single-quoted value preserved", () => {
    const { vars } = parseEnvContent("HASH='sha256#abc'");
    expect(vars[0]?.value).toBe("sha256#abc");
  });
});

describe(".env parser — escape sequences in double-quoted values", () => {
  test("\\n → newline", () => {
    const { vars } = parseEnvContent('CERT="line1\\nline2"');
    expect(vars[0]?.value).toBe("line1\nline2");
  });

  test("\\t → tab", () => {
    const { vars } = parseEnvContent('TSV="col1\\tcol2"');
    expect(vars[0]?.value).toBe("col1\tcol2");
  });

  test('\\" → double-quote', () => {
    const { vars } = parseEnvContent('MSG="say \\"hello\\""');
    expect(vars[0]?.value).toBe('say "hello"');
  });

  test("\\\\ → backslash", () => {
    const { vars } = parseEnvContent('PATH_WIN="C:\\\\Users"');
    expect(vars[0]?.value).toBe("C:\\Users");
  });

  test("single-quoted: backslash not treated as escape", () => {
    const { vars } = parseEnvContent("WIN='C:\\Users\\name'");
    expect(vars[0]?.value).toBe("C:\\Users\\name");
  });
});

describe(".env parser — multiline values", () => {
  test("double-quoted multiline", () => {
    const content = `CERT="-----BEGIN\nline2\n-----END"`;
    const { vars } = parseEnvContent(content);
    expect(vars[0]?.value).toBe("-----BEGIN\nline2\n-----END");
  });

  test("single-quoted multiline", () => {
    const content = `MSG='hello\nworld'`;
    const { vars } = parseEnvContent(content);
    expect(vars[0]?.value).toBe("hello\nworld");
  });
});

describe(".env parser — duplicate keys", () => {
  test("duplicate key → warning + uses later value", () => {
    const { vars, warnings } = parseEnvContent("FOO=first\nFOO=second");
    expect(vars).toHaveLength(1);
    expect(vars[0]?.value).toBe("second");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/ซ้ำ/);
  });

  test("three dupes → two warnings, last value kept", () => {
    const { vars, warnings } = parseEnvContent("X=a\nX=b\nX=c");
    expect(vars[0]?.value).toBe("c");
    expect(warnings).toHaveLength(2);
  });
});

describe(".env parser — invalid key formats", () => {
  test("key starting with digit → warning + skip", () => {
    const { vars, warnings } = parseEnvContent("1INVALID=bad");
    expect(vars).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/1INVALID/);
  });

  test("key with dash → warning + skip", () => {
    const { vars, warnings } = parseEnvContent("MY-KEY=bad");
    expect(vars).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });

  test("valid key with underscore and digits", () => {
    const { vars } = parseEnvContent("_MY_KEY_123=ok");
    expect(vars[0]?.key).toBe("_MY_KEY_123");
  });

  test("line without '=' → warning + skip", () => {
    const { vars, warnings } = parseEnvContent("NODASH\nFOO=bar");
    expect(vars).toHaveLength(1);
    expect(vars[0]?.key).toBe("FOO");
    expect(warnings).toHaveLength(1);
  });
});

describe(".env parser — edge cases", () => {
  test("empty content → empty result", () => {
    const { vars, warnings } = parseEnvContent("");
    expect(vars).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  test("only comments → empty result", () => {
    const { vars } = parseEnvContent("# comment\n# another");
    expect(vars).toHaveLength(0);
  });

  test("value with '=' sign inside → only first '=' is separator", () => {
    const { vars } = parseEnvContent("URL=http://x.com?a=1&b=2");
    expect(vars[0]?.value).toBe("http://x.com?a=1&b=2");
  });

  test("Windows CRLF line endings", () => {
    const { vars } = parseEnvContent("A=1\r\nB=2\r\n");
    expect(vars).toHaveLength(2);
    expect(vars[0]?.value).toBe("1");
    expect(vars[1]?.value).toBe("2");
  });
});
