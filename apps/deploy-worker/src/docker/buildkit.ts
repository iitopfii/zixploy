/**
 * Build adapter ผ่าน `docker buildx build` subprocess (docs/phase-03-deploy-engine.md:
 * "ใช้ subprocess API ของ Bun สำหรับ Git/BuildKit เฉพาะจุดที่ไม่มี Docker Engine API ที่เหมาะสม")
 *
 * ไม่มี registry push ใน MVP (single Docker host เท่านั้น — non-goal ที่ประกาศไว้แล้ว)
 * ดังนั้น "digest" ที่เก็บใน deployments.image_digest คือ image ID ในเครื่อง (content-addressable
 * ในตัวเองอยู่แล้วโดย Docker) ไม่ใช่ registry digest — ใช้แยกแยะ/อ้างอิงตอน rollback ได้เหมือนกัน
 *
 * สำคัญ: ฟังก์ชันนี้ไม่ redact stdout/stderr เอง (ต่างจาก git/clone.ts ที่ redact เพราะเกี่ยวกับ
 * token โดยตรง) — ผู้เรียก (M6 pipeline) ต้อง redactString() เองก่อน persist/log บรรทัด build
 * output ทุกบรรทัด เผื่อ build-arg หรือ base image reference มีข้อมูลอ่อนไหวหลุดมา
 *
 * ข้อจำกัดที่พบจริงระหว่างเทสต์ (สำคัญสำหรับ M7 cleanup): การ kill `docker` CLI client เมื่อ
 * timeout/cancel ทำให้ buildImage() คืนค่า/throw ทันทีเสมอ (ไม่ค้าง) แต่**ไม่รับประกันว่า build
 * ฝั่ง BuildKit server จะหยุดจริง** — เจอ image ที่ถูก tag สำเร็จหลัง cancel ไปแล้วจริงระหว่าง
 * debug (BuildKit builder เป็น process/container แยกที่ทำงานต่อแม้ client ตายไปแล้ว) M7's
 * cleanup ต้องกวาด image ที่ไม่ได้ผูกกับ deployment ที่ succeeded ไหนเลย (ไม่ใช่แค่ตาม
 * deployments.image_tag ที่เรารู้จัก) ไม่ใช่แค่ image ของ deployment ที่ failed ตามปกติ
 */

import { resolve } from "node:path";
import { AppError, BUILD_SANDBOX_LIMITS } from "@zixploy/shared";
import { isDiskFullError } from "../disk-full";

export interface BuildSecret {
  id: string;
  sourcePath: string;
}

/**
 * Sandbox limits ของ RUN instructions ระหว่าง build — default มาจาก BUILD_SANDBOX_LIMITS
 * (Phase 8 M1) เปิดให้ override ต่อ call ได้สำหรับเทสต์/tuning ในอนาคต ไม่ผูกกับ project settings
 */
export interface BuildResourceLimits {
  memoryMb: number;
  cpuQuota: number;
  cpuPeriod: number;
  nprocSoft: number;
  nprocHard: number;
}

export interface BuildImageParams {
  contextDir: string;
  /** relative ต่อ contextDir */
  dockerfilePath: string;
  tag: string;
  target?: string | null;
  buildArgs?: Record<string, string>;
  /** BuildKit --secret เท่านั้น — ห้ามส่ง secret ผ่าน buildArgs (threat-model.md) */
  secrets?: BuildSecret[];
  labels: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  /** เรียกทุกบรรทัดของ build output — ผู้เรียกต้อง redact เอง (ดู comment บนสุดของไฟล์) */
  onLog: (line: string) => void;
  /** ไม่ระบุ → ใช้ BUILD_SANDBOX_LIMITS (ค่า platform-wide) */
  resourceLimits?: BuildResourceLimits;
}

export interface BuildImageResult {
  imageId: string;
  /** local image ID เสมอในตอนนี้ (ไม่มี registry) — ดู comment บนสุดของไฟล์ */
  digest: string;
}

/**
 * อ่าน stream ทั้งก้อนผ่าน Response(...).text() แล้วค่อย split เป็นบรรทัด
 *
 * สำคัญ — พิสูจน์จริงระหว่าง implement: เมื่อ `docker buildx build` ถูก kill (ทั้ง SIGTERM ผ่าน
 * AbortSignal และ SIGKILL ตรง ๆ) `proc.exited` resolve ปกติเร็ว แต่ stdout/stderr pipe ไม่ส่ง EOF
 * เลย — ค้างตลอดไปไม่ว่าจะอ่านด้วย manual stream.getReader() loop หรือ Response(stream).text()
 * ก็ตาม (แตกต่างจาก git/docker CLI ธรรมดาอื่น ๆ ที่ปิด pipe ปกติ) สันนิษฐานว่า buildx spawn/สืบทอด
 * ไปยัง process อื่น (helper/buildkit proxy) ที่ยังถือ pipe write-end อยู่แม้ process หลักตายแล้ว
 *
 * ทางแก้: await proc.exited ก่อนเสมอ (reliable) แล้วค่อย "พยายาม" อ่าน pipe ที่เหลือแบบมี
 * grace period จำกัด — ถ้าไม่ได้ผลใน gracePeriodMs ก็ปล่อยผ่านไปเลย (ไม่ค้างเด็ดขาด)
 * ผลข้างเคียง: อาจไม่ได้ log ครบทุกบรรทัดกรณีนี้เกิดขึ้นจริง (rare — เกิดเฉพาะตอน cancel/timeout
 * ซึ่งไม่ต้องการ log ที่ครบเป๊ะอยู่แล้ว ต่างจาก happy path ที่ pipe ปิดปกติเสมอ)
 */
async function readAllLinesWithGracePeriod(
  stream: ReadableStream<Uint8Array> | null,
  gracePeriodMs: number,
): Promise<string[]> {
  if (!stream) return [];
  const textPromise = new Response(stream).text();
  const text = await Promise.race([
    textPromise,
    new Promise<string>((resolve) => setTimeout(() => resolve(""), gracePeriodMs)),
  ]);
  return text.split("\n").filter((line) => line.trim());
}

/** grace period สำหรับอ่าน pipe ที่เหลือหลัง process จบ/ถูก kill แล้ว */
const PIPE_DRAIN_GRACE_MS = 2_000;

function truncate(text: string, max = 800): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

const DOCKERFILE_MISSING_RE =
  /failed to read dockerfile|dockerfile: no such file|no such file.*dockerfile/i;

/**
 * สร้าง argv ของ `docker buildx build` ล้วน ๆ (ไม่ spawn) — แยกออกมาให้เทสต์ตรวจ flag ได้โดยไม่ต้องมี
 * Docker daemon จริง ดู BuildResourceLimits: จำกัด memory/cpu/nproc ของแต่ละ RUN step (Phase 8 M1)
 */
export function buildBuildxArgs(params: BuildImageParams): string[] {
  const { contextDir, dockerfilePath, tag, target, buildArgs, secrets, labels } = params;
  const limits = params.resourceLimits ?? BUILD_SANDBOX_LIMITS;

  // -f resolve เทียบ cwd ของ subprocess เอง (repo root) ไม่ใช่ contextDir — ต้องส่ง absolute path เสมอ
  const absoluteDockerfilePath = resolve(contextDir, dockerfilePath);
  const args = [
    "buildx",
    "build",
    "--progress=plain",
    "-f",
    absoluteDockerfilePath,
    "-t",
    tag,
    "--load",
    "--resource",
    `memory=${limits.memoryMb}m`,
    "--resource",
    `cpu-quota=${limits.cpuQuota}`,
    "--resource",
    `cpu-period=${limits.cpuPeriod}`,
    "--ulimit",
    `nproc=${limits.nprocSoft}:${limits.nprocHard}`,
  ];
  if (target) args.push("--target", target);
  for (const [k, v] of Object.entries(buildArgs ?? {})) args.push("--build-arg", `${k}=${v}`);
  for (const s of secrets ?? []) args.push("--secret", `id=${s.id},src=${s.sourcePath}`);
  for (const [k, v] of Object.entries(labels)) args.push("--label", `${k}=${v}`);
  args.push(contextDir);
  return args;
}

export async function buildImage(params: BuildImageParams): Promise<BuildImageResult> {
  const { dockerfilePath, tag, timeoutMs, signal, onLog } = params;
  const args = buildBuildxArgs(params);

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const combinedSignal = AbortSignal.any([signal, timeoutController.signal]);

  try {
    const proc = Bun.spawn(["docker", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      signal: combinedSignal,
    });

    // await proc.exited ก่อนเสมอ (reliable แม้ pipe ค้าง — ดู comment บน readAllLinesWithGracePeriod)
    const code = await proc.exited;
    const [stdoutLines, stderrLines] = await Promise.all([
      readAllLinesWithGracePeriod(proc.stdout, PIPE_DRAIN_GRACE_MS),
      readAllLinesWithGracePeriod(proc.stderr, PIPE_DRAIN_GRACE_MS),
    ]);
    for (const line of stdoutLines) onLog(line);
    for (const line of stderrLines) onLog(line);

    if (code !== 0) {
      const stderrText = stderrLines.join("\n");
      if (timeoutController.signal.aborted) {
        throw new AppError("BUILD_TIMEOUT", `build เกินเวลาที่กำหนด (${timeoutMs}ms)`);
      }
      if (isDiskFullError(stderrText)) {
        throw new AppError("DISK_FULL", `เนื้อที่ดิสก์เต็มระหว่าง build: ${truncate(stderrText)}`);
      }
      if (DOCKERFILE_MISSING_RE.test(stderrText)) {
        throw new AppError("DOCKERFILE_NOT_FOUND", `ไม่พบ Dockerfile: ${dockerfilePath}`);
      }
      throw new AppError("BUILD_FAILED", `docker build ล้มเหลว: ${truncate(stderrText)}`);
    }
  } finally {
    clearTimeout(timer);
  }

  return inspectBuiltImage(tag);
}

async function inspectBuiltImage(tag: string): Promise<BuildImageResult> {
  const proc = Bun.spawn(["docker", "image", "inspect", tag], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new AppError("BUILD_FAILED", `build สำเร็จแต่ inspect image ไม่ได้: ${tag}`);
  }

  let parsed: Array<{ Id: string; RepoDigests?: string[] }>;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new AppError("BUILD_FAILED", `build สำเร็จแต่ parse image inspect ไม่ได้: ${tag}`);
  }
  const info = parsed[0];
  if (!info?.Id) {
    throw new AppError("BUILD_FAILED", `build สำเร็จแต่ inspect image ว่างเปล่า: ${tag}`);
  }

  return { imageId: info.Id, digest: info.RepoDigests?.[0] ?? info.Id };
}
