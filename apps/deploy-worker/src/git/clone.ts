/**
 * Git clone แบบ exact commit SHA — ไม่ clone branch tip เฉย ๆ (ป้องกัน TOCTOU ระหว่าง
 * webhook รับ push กับตอน worker clone จริง — commit ที่ deploy ต้องตรงกับที่ webhook ระบุเป๊ะ)
 *
 * Token ถูกฝังใน remote URL รูปแบบ `x-access-token:<token>@github.com` และส่งตรงไปใน
 * `git fetch <url>` โดยไม่ผ่าน `git remote add` ก่อน — ดังนั้น token ไม่ถูกบันทึกลง `.git/config`
 *
 * ทำไมไม่ใช้ `http.extraheader` (ตาม threat model เดิม):
 * ทดสอบบน git 2.49.1 / Alpine บน VPS จริง — ทุก format (bearer/Bearer/token) fail exit 128
 * ไม่ว่าจะ disable credential.helper ก่อนหรือไม่ ทำให้ต้องใช้ URL-embedded approach แทน
 *
 * Security mitigations:
 * - stdout/stderr ทุกบรรทัดผ่าน redactString() ก่อนส่งให้ onLog หรือใส่ใน error message
 *   (CREDENTIAL_URL_RE ครอบ `user:pass@` ในข้อความ error ของ git, GITHUB_TOKEN_RE ครอบ ghs_*)
 * - argv ของ subprocess ยังมองเห็นได้จาก process อื่นที่มีสิทธิ์เพียงพอ —
 *   accepted risk เดิมที่ thread model ยอมรับ (worker มีสิทธิ์ Docker root-equivalent อยู่แล้ว)
 *   เป้าหมายคือกัน token ไม่ให้ "persist ลง log/DB" ซึ่งยังบรรลุได้ผ่าน redactString()
 */

import { mkdirSync } from "node:fs";
import { AppError, redactString } from "@zixploy/shared";
import { isDiskFullError } from "../disk-full";

export interface CloneParams {
  repoFullName: string;
  commitSha: string;
  token: string;
  destDir: string;
  timeoutMs: number;
  signal: AbortSignal;
  onLog?: (line: string) => void;
  /** ฉีดสำหรับเทสต์ — override remote URL (เช่นชี้ไปที่ local bare repo แทน github.com) */
  remoteUrl?: string;
}

interface RunResult {
  code: number;
  stderr: string;
}

async function run(
  args: string[],
  opts: { signal: AbortSignal; onLog: ((line: string) => void) | undefined },
): Promise<RunResult> {
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    signal: opts.signal,
    env: {
      ...process.env,
      // ป้องกัน git พยายาม prompt credentials ทาง /dev/tty (ไม่มีใน container)
      // แทนที่จะ fail ด้วย "No such device or address" จะ fail ทันทีพร้อม auth error จริง
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "echo",
    },
  });

  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;

  if (opts.onLog) {
    for (const line of stdoutText.split("\n")) {
      if (line.trim()) opts.onLog(redactString(line));
    }
    for (const line of stderrText.split("\n")) {
      if (line.trim()) opts.onLog(redactString(line));
    }
  }

  return { code, stderr: redactString(stderrText) };
}

function truncate(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Clone แบบ shallow + checkout ตรง SHA — ไม่ต้องรู้ branch name
 * (`git fetch origin <sha>` ใช้งานได้บน GitHub เพราะเปิด allowReachableSHA1InWant)
 */
export async function cloneCommit(params: CloneParams): Promise<void> {
  const { repoFullName, commitSha, token, destDir, timeoutMs, signal, onLog } = params;
  // URL-based auth: x-access-token:<token>@github.com (ไม่ผ่าน git remote add → token ไม่ถูกบันทึกลง .git/config)
  // เมื่อ remoteUrl ถูก inject (tests/local) จะ override และไม่มี token ใน URL เลย
  const url = params.remoteUrl ?? `https://x-access-token:${token}@github.com/${repoFullName}.git`;

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const combinedSignal = AbortSignal.any([signal, timeoutController.signal]);

  try {
    mkdirSync(destDir, { recursive: true });

    let result = await run(["git", "init", destDir], { signal: combinedSignal, onLog });
    if (result.code !== 0) {
      if (isDiskFullError(result.stderr)) {
        throw new AppError("DISK_FULL", `เนื้อที่ดิสก์เต็มระหว่าง git init: ${truncate(result.stderr)}`);
      }
      throw new AppError("CLONE_FAILED", `git init ล้มเหลว: ${truncate(result.stderr)}`);
    }

    // ส่ง URL ตรงไปที่ git fetch (ไม่ผ่าน remote add) — token ไม่ถูก persist ใน .git/config
    // -c credential.helper= ปิด credential helper ทั้งหมดเพื่อกัน git พยายาม prompt หรือ
    // ใช้ stored credentials อื่นที่อาจ override URL-based auth
    result = await run(
      ["git", "-C", destDir, "-c", "credential.helper=", "fetch", "--depth", "1", url, commitSha],
      { signal: combinedSignal, onLog },
    );
    if (result.code !== 0) {
      if (isDiskFullError(result.stderr)) {
        throw new AppError("DISK_FULL", `เนื้อที่ดิสก์เต็มระหว่าง git fetch: ${truncate(result.stderr)}`);
      }
      if (combinedSignal.aborted && timeoutController.signal.aborted) {
        throw new AppError("CLONE_FAILED", "git fetch timeout");
      }
      throw new AppError(
        "CLONE_FAILED",
        `git fetch ล้มเหลว (commit อาจไม่มีอยู่จริงหรือ token ไม่ถูกต้อง): ${truncate(result.stderr)}`,
      );
    }

    result = await run(["git", "-C", destDir, "checkout", "FETCH_HEAD"], {
      signal: combinedSignal,
      onLog,
    });
    if (result.code !== 0) {
      if (isDiskFullError(result.stderr)) {
        throw new AppError(
          "DISK_FULL",
          `เนื้อที่ดิสก์เต็มระหว่าง git checkout: ${truncate(result.stderr)}`,
        );
      }
      throw new AppError("CLONE_FAILED", `git checkout ล้มเหลว: ${truncate(result.stderr)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
