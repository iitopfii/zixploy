/**
 * Git clone แบบ exact commit SHA — ไม่ clone branch tip เฉย ๆ (ป้องกัน TOCTOU ระหว่าง
 * webhook รับ push กับตอน worker clone จริง — commit ที่ deploy ต้องตรงกับที่ webhook ระบุเป๊ะ)
 *
 * Token ไม่ใส่ในตัว URL — ใช้ `git -c http.extraheader="AUTHORIZATION: bearer <token>"` แทน
 * ป้องกัน token หลุดเข้า URL ที่อาจถูก echo ใน error message แล้วถูก log persist
 * (docs/threat-model.md: "Installation token ไม่เข้า clone URL ที่ถูก log")
 * หมายเหตุ: argv ของ subprocess เองยังมองเห็นได้จาก process อื่นบนเครื่องเดียวกันที่มีสิทธิ์เพียงพอ
 * (เหมือนกับทุก subprocess-based credential passing) — นี่ไม่ใช่ช่องโหว่ใหม่เทียบกับที่ worker
 * มีสิทธิ์ Docker root-equivalent อยู่แล้ว เป้าหมายคือกัน token ไม่ให้ "persist ลง log/DB"
 *
 * stdout/stderr ทุกบรรทัดผ่าน redactString() ก่อนส่งให้ onLog — เผื่อ token หลุดมาในข้อความ error
 */

import { mkdirSync } from "node:fs";
import { AppError, redactString } from "@zixploy/shared";

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
  const url = params.remoteUrl ?? `https://github.com/${repoFullName}.git`;
  const extraHeader = `http.extraheader=AUTHORIZATION: bearer ${token}`;

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const combinedSignal = AbortSignal.any([signal, timeoutController.signal]);

  try {
    mkdirSync(destDir, { recursive: true });

    let result = await run(["git", "init", destDir], { signal: combinedSignal, onLog });
    if (result.code !== 0) {
      throw new AppError("CLONE_FAILED", `git init ล้มเหลว: ${truncate(result.stderr)}`);
    }

    result = await run(["git", "-C", destDir, "remote", "add", "origin", url], {
      signal: combinedSignal,
      onLog,
    });
    if (result.code !== 0) {
      throw new AppError("CLONE_FAILED", `git remote add ล้มเหลว: ${truncate(result.stderr)}`);
    }

    result = await run(
      ["git", "-C", destDir, "-c", extraHeader, "fetch", "--depth", "1", "origin", commitSha],
      { signal: combinedSignal, onLog },
    );
    if (result.code !== 0) {
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
      throw new AppError("CLONE_FAILED", `git checkout ล้มเหลว: ${truncate(result.stderr)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
