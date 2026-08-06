/**
 * .env file parser — docs/phase-04-environment.md "Import .env พร้อม preview/conflict resolution"
 *
 * รองรับ:
 * - KEY=VALUE (unquoted — trailing whitespace + inline comment ถูกตัด)
 * - KEY="VALUE" (double-quoted — \\n \\t \\" \\\\ ถูก unescape)
 * - KEY='VALUE' (single-quoted — literal ไม่มี escape)
 * - export KEY=VALUE (prefix export ถูก strip)
 * - # comment (ทั้งบรรทัด)
 * - บรรทัดว่าง (ข้าม)
 * - key ซ้ำ → เก็บค่าหลัง + warning
 * - key format ไม่ถูก → warning + ข้าม
 *
 * ไม่แตะ DB — parse/preview เท่านั้น
 */

import { ENV_VAR_KEY_RE } from "@zixploy/shared";

export interface ParsedEnvVar {
  key: string;
  value: string;
  lineNumber: number;
}

export interface ParseResult {
  vars: ParsedEnvVar[];
  warnings: string[];
}

export function parseEnvContent(content: string): ParseResult {
  const lines = content.split(/\r?\n/);
  const vars: ParsedEnvVar[] = [];
  const warnings: string[] = [];
  const seenKeys = new Map<string, number>(); // key → first line number

  let i = 0;
  while (i < lines.length) {
    const lineNumber = i + 1;
    const raw = lines[i] ?? "";
    i++;

    const trimmed = raw.trim();
    // blank line or comment
    if (!trimmed || trimmed.startsWith("#")) continue;

    // strip optional "export " prefix
    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;

    const eqIdx = withoutExport.indexOf("=");
    if (eqIdx === -1) {
      warnings.push(`บรรทัด ${lineNumber}: ข้ามเพราะไม่พบ '=' — ต้องเป็นรูปแบบ KEY=VALUE`);
      continue;
    }

    const key = withoutExport.slice(0, eqIdx).trim();
    const rest = withoutExport.slice(eqIdx + 1); // อาจว่าง

    // validate key format
    if (!ENV_VAR_KEY_RE.test(key)) {
      warnings.push(`บรรทัด ${lineNumber}: ข้าม key "${key}" — ต้องขึ้นต้นด้วยตัวอักษรหรือ underscore`);
      continue;
    }

    let value: string;
    let nextI = i;

    if (rest.startsWith('"')) {
      const r = parseDoubleQuoted(rest.slice(1), lines, i);
      value = r.value;
      nextI = r.nextLineIdx;
    } else if (rest.startsWith("'")) {
      const r = parseSingleQuoted(rest.slice(1), lines, i);
      value = r.value;
      nextI = r.nextLineIdx;
    } else {
      value = stripInlineComment(rest).trim();
      nextI = i;
    }

    i = nextI;

    // duplicate key check
    if (seenKeys.has(key)) {
      warnings.push(`บรรทัด ${lineNumber}: key "${key}" ซ้ำกับบรรทัด ${seenKeys.get(key)} — ใช้ค่าใหม่`);
      // replace previous entry
      const idx = vars.findIndex((v) => v.key === key);
      if (idx !== -1) vars.splice(idx, 1);
    }
    seenKeys.set(key, lineNumber);
    vars.push({ key, value, lineNumber });
  }

  return { vars, warnings };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripInlineComment(s: string): string {
  // ตัด inline comment ที่มี whitespace นำหน้า # เช่น VALUE # comment
  const m = s.match(/^(.*?)\s+#.*$/);
  return m ? (m[1] ?? s) : s;
}

interface QuoteResult {
  value: string;
  nextLineIdx: number; // index ใน lines[] ที่จะอ่านต่อ (หลัง closing quote)
}

function parseDoubleQuoted(
  afterOpenQuote: string,
  lines: readonly string[],
  startLineIdx: number,
): QuoteResult {
  let buf = "";
  let chunk = afterOpenQuote;
  let idx = startLineIdx;

  while (true) {
    const closePos = findUnescapedChar(chunk, '"');
    if (closePos !== -1) {
      buf += unescapeDouble(chunk.slice(0, closePos));
      return { value: buf, nextLineIdx: idx };
    }
    // no closing quote on this line — multiline
    buf += unescapeDouble(chunk) + "\n";
    if (idx >= lines.length) break;
    chunk = lines[idx] ?? "";
    idx++;
  }
  // unterminated — return what we have
  return { value: buf, nextLineIdx: idx };
}

function parseSingleQuoted(
  afterOpenQuote: string,
  lines: readonly string[],
  startLineIdx: number,
): QuoteResult {
  let buf = "";
  let chunk = afterOpenQuote;
  let idx = startLineIdx;

  while (true) {
    const closePos = chunk.indexOf("'");
    if (closePos !== -1) {
      buf += chunk.slice(0, closePos);
      return { value: buf, nextLineIdx: idx };
    }
    buf += chunk + "\n";
    if (idx >= lines.length) break;
    chunk = lines[idx] ?? "";
    idx++;
  }
  return { value: buf, nextLineIdx: idx };
}

/** หา index ของ char ที่ไม่ถูก escape ด้วย backslash */
function findUnescapedChar(s: string, ch: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) {
      i++; // skip next char
      continue;
    }
    if (s[i] === ch) return i;
  }
  return -1;
}

function unescapeDouble(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}
