/**
 * Docker Compose import (Phase 13) — ดึง build config จาก docker-compose.yml มาเติมฟอร์ม
 * ProjectSettingsForm (dockerfilePath/buildContext/internalPort) — ใช้เฉพาะ service แรกที่มี `build:`
 *
 * ตั้งใจให้เป็น parser แบบ best-effort รองรับ subset ที่พบบ่อยที่สุดเท่านั้น (indentation-based,
 * ไม่รองรับ YAML เต็มรูปแบบ เช่น anchors/multi-doc/flow map ซ้อนลึก) — ผลลัพธ์ต้องให้ผู้ใช้ตรวจสอบ
 * ก่อนกดบันทึกเสมอ ไม่เคยเซฟอัตโนมัติ (ดู ProjectSettingsForm.vue) จึง parse ผิดได้โดยไม่มีผลข้างเคียง
 */

export interface ParsedComposeConfig {
  serviceName: string;
  dockerfilePath: string;
  buildContext: string;
  internalPort: number | null;
  warnings: string[];
}

export type ParseComposeResult =
  | { ok: true; value: ParsedComposeConfig }
  | { ok: false; error: string };

function indentOf(line: string): number {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].length : 0;
}

function stripInlineComment(line: string): string {
  // ตัด ` # ...` ท้ายบรรทัดแบบหยาบ ๆ — ไม่รองรับ # ที่อยู่ในสตริงเครื่องหมายคำพูด (edge case ยอมรับได้)
  const idx = line.indexOf(" #");
  return idx === -1 ? line : line.slice(0, idx);
}

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/** แยก key: value จากบรรทัดเดียว — คืน null ถ้าไม่ใช่รูปแบบ key: value */
function splitKeyValue(line: string): { key: string; value: string } | null {
  const trimmed = stripInlineComment(line).trim();
  const idx = trimmed.indexOf(":");
  if (idx === -1) return null;
  return { key: trimmed.slice(0, idx).trim(), value: trimmed.slice(idx + 1).trim() };
}

/** ดึง port แรกจาก ports: ไม่ว่าจะเป็น flow list (`["8080:80"]`) หรือ block list (`- "8080:80"`) */
function extractFirstPort(raw: string): number | null {
  const cleaned = unquote(raw.replace(/^-\s*/, "").replace(/[[\]]/g, "").split(",")[0] ?? "");
  const withoutProtocol = cleaned.split("/")[0] ?? cleaned;
  const parts = withoutProtocol.split(":");
  const containerPort = parts[parts.length - 1];
  const port = Number(containerPort);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function parseComposeForBuildConfig(source: string): ParseComposeResult {
  const lines = source.replace(/\r\n/g, "\n").split("\n");

  const servicesIdx = lines.findIndex(
    (l) => stripInlineComment(l).trim() === "services:" && indentOf(l) === 0,
  );
  if (servicesIdx === -1) {
    return { ok: false, error: "ไม่พบ 'services:' ระดับบนสุด — ไฟล์นี้ดูไม่ใช่ docker-compose.yml" };
  }

  // ขอบเขต services block: ตั้งแต่บรรทัดถัดไป จนกว่าจะเจอ key ระดับบนสุด (indent 0) อีกครั้ง หรือจบไฟล์
  let end = lines.length;
  for (let i = servicesIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (indentOf(line) === 0) {
      end = i;
      break;
    }
  }
  const block = lines.slice(servicesIdx + 1, end);
  const nonEmpty = block.filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  if (nonEmpty.length === 0) {
    return { ok: false, error: "'services:' ว่างเปล่า — ไม่มี service ให้นำเข้า" };
  }

  // service name อยู่ที่ indent ต่ำสุดในบล็อกนี้ (บรรทัดแรกสุดที่มี indent เท่ากับ min)
  const minIndent = Math.min(...nonEmpty.map(indentOf));
  const serviceNameLines = block
    .map((line, idx) => ({ line, idx }))
    .filter(({ line }) => line.trim() !== "" && indentOf(line) === minIndent);

  if (serviceNameLines.length === 0) {
    return { ok: false, error: "หา service ไม่เจอ — ตรวจสอบ indentation ของไฟล์" };
  }

  const first = serviceNameLines[0]!;
  const kv = splitKeyValue(first.line);
  if (!kv || kv.value !== "") {
    return { ok: false, error: "รูปแบบ service ไม่ตรงที่คาดไว้ — ต้องเป็น '<ชื่อ service>:' บรรทัดเดียว" };
  }
  const serviceName = kv.key;

  const nextServiceIdx =
    serviceNameLines.length > 1 ? (serviceNameLines[1]?.idx ?? block.length) : block.length;
  const serviceBlock = block.slice(first.idx + 1, nextServiceIdx);

  const warnings: string[] = [];
  if (serviceNameLines.length > 1) {
    warnings.push(
      `ไฟล์นี้มี ${serviceNameLines.length} service — ใช้เฉพาะ service แรก ("${serviceName}") เท่านั้น เพราะ project ในระบบนี้รองรับ 1 container ต่อ project`,
    );
  }

  // property ของ service อยู่ที่ indent ต่ำสุดใน serviceBlock
  const serviceNonEmpty = serviceBlock.filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  if (serviceNonEmpty.length === 0) {
    return { ok: false, error: `service "${serviceName}" ว่างเปล่า` };
  }
  const propIndent = Math.min(...serviceNonEmpty.map(indentOf));

  let dockerfilePath = "Dockerfile";
  let buildContext = ".";
  let internalPort: number | null = null;
  let hasBuild = false;
  let hasImage = false;

  for (let i = 0; i < serviceBlock.length; i++) {
    const line = serviceBlock[i] ?? "";
    if (line.trim() === "" || indentOf(line) !== propIndent) continue;
    const prop = splitKeyValue(line);
    if (!prop) continue;

    if (prop.key === "image") {
      hasImage = true;
    } else if (prop.key === "build") {
      hasBuild = true;
      if (prop.value !== "") {
        // shorthand: build: ./path  หรือ  build: .
        buildContext = unquote(prop.value);
      } else {
        // nested map: context:/dockerfile: ที่ indent ลึกกว่า propIndent
        for (let j = i + 1; j < serviceBlock.length; j++) {
          const sub = serviceBlock[j] ?? "";
          if (sub.trim() === "") continue;
          if (indentOf(sub) <= propIndent) break;
          const subKv = splitKeyValue(sub);
          if (!subKv) continue;
          if (subKv.key === "context") buildContext = unquote(subKv.value);
          if (subKv.key === "dockerfile") dockerfilePath = unquote(subKv.value);
        }
      }
    } else if (prop.key === "ports") {
      if (prop.value.startsWith("[")) {
        // flow list บรรทัดเดียว: ports: ["3000:3000", "9229:9229"]
        const inner = prop.value.slice(
          1,
          prop.value.indexOf("]") === -1 ? undefined : prop.value.indexOf("]"),
        );
        const firstEntry = inner.split(",")[0];
        if (firstEntry) internalPort = extractFirstPort(firstEntry);
      } else {
        // block list: บรรทัดถัดไปที่เยื้องลึกกว่า ขึ้นต้นด้วย "- "
        for (let j = i + 1; j < serviceBlock.length; j++) {
          const sub = serviceBlock[j] ?? "";
          if (sub.trim() === "") continue;
          if (indentOf(sub) <= propIndent) break;
          if (sub.trim().startsWith("-")) {
            internalPort = extractFirstPort(sub.trim());
            break;
          }
        }
      }
    }
  }

  if (!hasBuild) {
    return {
      ok: false,
      error: hasImage
        ? `service "${serviceName}" ใช้ image สำเร็จรูป (ไม่มี 'build:') — นำเข้าแบบนี้ไม่ได้ ต้องมี build.context/dockerfile ในไฟล์`
        : `service "${serviceName}" ไม่มี 'build:' หรือ 'image:' — ตรวจสอบไฟล์อีกครั้ง`,
    };
  }

  if (!internalPort) {
    warnings.push("ไม่พบ 'ports:' ในไฟล์ — ต้องระบุ internal port เองหลังนำเข้า");
  }

  return {
    ok: true,
    value: { serviceName, dockerfilePath, buildContext, internalPort, warnings },
  };
}
