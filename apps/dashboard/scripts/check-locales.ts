/**
 * ตรวจไฟล์ภาษาของ dashboard — `bun run i18n:check`
 *
 *   1. ทุกไฟล์มีครบทั้ง th และ en และมี key ชุดเดียวกัน
 *   2. key ที่โค้ดเรียกแบบ static ($t / t / tr / trCount / hasMessage / apiErrorMessage / keypath)
 *      มีอยู่จริงในไฟล์ภาษา
 *   3. ไม่มีข้อความภาษาไทยค้างอยู่ในโค้ด (นอก comment) — ทุกข้อความต้องมาจากไฟล์ภาษา
 *
 * ออกด้วย exit code 1 เมื่อพบปัญหา · ส่ง path ต่อท้ายเพื่อตรวจข้อ 3 เฉพาะไฟล์นั้น
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const LOCALES_DIR = join(ROOT, "i18n", "locales");
const APP_DIR = join(ROOT, "app");
const THAI = /[฀-๿]/;

const problems: string[] = [];

function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (typeof value === "string") {
    out.set(prefix, value);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
  }
}

function loadLocale(lang: string): Map<string, string> {
  const messages = new Map<string, string>();
  for (const file of readdirSync(join(LOCALES_DIR, lang)).sort()) {
    if (!file.endsWith(".json")) continue;
    const ns = file.slice(0, -".json".length);
    const data = JSON.parse(readFileSync(join(LOCALES_DIR, lang, file), "utf8")) as Record<
      string,
      unknown
    >;
    const top = Object.keys(data);
    if (top.length !== 1 || top[0] !== ns) {
      problems.push(`${lang}/${file}: ต้องมี key บนสุดตัวเดียวชื่อ "${ns}"`);
    }
    flatten(data, "", messages);
  }
  return messages;
}

const th = loadLocale("th");
const en = loadLocale("en");

// 1. key ชุดเดียวกัน + ภาษาอังกฤษต้องไม่มีอักษรไทย
for (const key of th.keys()) if (!en.has(key)) problems.push(`en ขาด key: ${key}`);
for (const key of en.keys()) if (!th.has(key)) problems.push(`th ขาด key: ${key}`);
for (const [key, value] of en) {
  if (THAI.test(value)) problems.push(`en มีอักษรไทย: ${key}`);
}
// ตัวแปร {name} ต้องตรงกันทั้งสองภาษา
const params = (text: string) => [...text.matchAll(/\{([a-zA-Z_]\w*)\}/g)].map((m) => m[1]).sort();
for (const [key, value] of th) {
  const other = en.get(key);
  if (other !== undefined && params(value).join() !== [...new Set(params(other))].sort().join()) {
    if ([...new Set(params(value))].join() !== [...new Set(params(other))].join()) {
      problems.push(`ตัวแปรไม่ตรงกัน: ${key}`);
    }
  }
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(vue|ts)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** ตัด comment ออก (เก็บจำนวนบรรทัดไว้) — comment ภาษาไทยในโค้ดเป็นเรื่องปกติของ repo นี้ */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ""))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const only = process.argv.slice(2).map((p) => p.replaceAll("\\", "/"));
const KEY_CALL =
  /(?:\$t|\bt|\btr|\btrCount|\bhasMessage|\$te|\bte)\(\s*["']([a-zA-Z0-9_.-]+)["']|keypath="([a-zA-Z0-9_.-]+)"|apiErrorMessage\([^,]+,\s*["']([a-zA-Z0-9_.-]+)["']/g;

for (const file of sourceFiles(APP_DIR)) {
  const rel = relative(ROOT, file).replaceAll("\\", "/");
  const source = stripComments(readFileSync(file, "utf8"));

  // 2. key ที่เรียกแบบ static ต้องมีอยู่จริง
  for (const match of source.matchAll(KEY_CALL)) {
    const key = match[1] ?? match[2] ?? match[3];
    if (key?.includes(".") && !th.has(key)) problems.push(`${rel}: ไม่มี key "${key}"`);
  }

  // 3. ข้อความไทยค้างในโค้ด
  if (only.length > 0 && !only.some((p) => rel.endsWith(p) || p.endsWith(rel))) continue;
  source.split("\n").forEach((line, index) => {
    if (THAI.test(line)) problems.push(`${rel}:${index + 1}: ข้อความไทยในโค้ด — ${line.trim()}`);
  });
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`\nพบ ${problems.length} จุด`);
  process.exit(1);
}
console.log(`ไฟล์ภาษาครบ: ${th.size} key ทั้ง th และ en`);
