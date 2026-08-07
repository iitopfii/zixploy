import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@zixploy/shared";
import { cloneCommit } from "../src/git/clone";

const dirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "zixploy-clone-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows อาจปล่อย handle ช้า — ปล่อยให้ OS เก็บกวาด
    }
  }
});

/** สร้าง local bare git repo พร้อม 1 commit — ใช้เป็น "remote" ปลอมไม่ต้องต่อเน็ต */
async function makeSourceRepoWithCommit(): Promise<{ bareDir: string; commitSha: string }> {
  const sourceDir = tempDir();
  const bareDir = tempDir();

  async function run(args: string[], cwd: string) {
    const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    if (proc.exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`fixture setup failed: ${args.join(" ")}\n${stderr}`);
    }
  }

  await run(["git", "init", "-b", "main", sourceDir], process.cwd());
  await run(["git", "-C", sourceDir, "config", "user.email", "test@example.com"], process.cwd());
  await run(["git", "-C", sourceDir, "config", "user.name", "Test"], process.cwd());
  writeFileSync(join(sourceDir, "Dockerfile"), "FROM scratch\n");
  await run(["git", "-C", sourceDir, "add", "."], process.cwd());
  await run(["git", "-C", sourceDir, "commit", "-m", "initial"], process.cwd());

  const revParse = Bun.spawn(["git", "-C", sourceDir, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const commitSha = (await new Response(revParse.stdout).text()).trim();
  await revParse.exited;

  // bare clone = "remote" repo ที่ cloneCommit จะ fetch จาก
  rmSync(bareDir, { recursive: true, force: true });
  await run(["git", "clone", "--bare", sourceDir, bareDir], process.cwd());

  return { bareDir, commitSha };
}

describe("cloneCommit", () => {
  test("clone + checkout exact commit SHA สำเร็จ", async () => {
    const { bareDir, commitSha } = await makeSourceRepoWithCommit();
    const destDir = tempDir();
    const logs: string[] = [];

    await cloneCommit({
      repoFullName: "unused/unused",
      commitSha,
      token: "test-token",
      destDir,
      timeoutMs: 15_000,
      signal: new AbortController().signal,
      remoteUrl: bareDir,
      onLog: (line) => logs.push(line),
    });

    const proc = Bun.spawn(["git", "-C", destDir, "rev-parse", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const head = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    expect(head).toBe(commitSha);

    // ไฟล์ที่ commit ไว้ต้องอยู่จริงหลัง checkout
    expect(await Bun.file(join(destDir, "Dockerfile")).exists()).toBe(true);
  });

  test("commit SHA ไม่มีอยู่จริง → AppError CLONE_FAILED, ไม่ throw exception ดิบ", async () => {
    const { bareDir } = await makeSourceRepoWithCommit();
    const destDir = tempDir();
    const fakeSha = "f".repeat(40);

    let caught: unknown;
    try {
      await cloneCommit({
        repoFullName: "unused/unused",
        commitSha: fakeSha,
        token: "test-token",
        destDir,
        timeoutMs: 15_000,
        signal: new AbortController().signal,
        remoteUrl: bareDir,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("CLONE_FAILED");
  });

  test("bare repo ไม่มีอยู่จริงเลย (invalid remote) → AppError CLONE_FAILED", async () => {
    const destDir = tempDir();
    let caught: unknown;
    try {
      await cloneCommit({
        repoFullName: "unused/unused",
        commitSha: "a".repeat(40),
        token: "test-token",
        destDir,
        timeoutMs: 15_000,
        signal: new AbortController().signal,
        remoteUrl: join(tmpdir(), "zixploy-definitely-does-not-exist-repo"),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("CLONE_FAILED");
  });

  test("token ไม่หลุดใน error log — redactString() ครอบ stdout/stderr/error message ทั้งหมด", async () => {
    const destDir = tempDir();
    const secretToken = "ghs_verysecrettoken1234567890abcdefgh";
    const logs: string[] = [];

    let caught: unknown;
    try {
      // ชี้ไป localhost port ที่ไม่มีอะไร listen — fail เร็ว offline ล้วน ๆ ไม่ต้องต่อเน็ตจริง
      // remoteUrl override ทำให้ token ไม่เข้าไปใน URL เลย (ไม่มีผลกับ redactString แต่ทดสอบ
      // ว่า token param ไม่รั่วผ่าน mechanism อื่น เช่น env var หรือ subprocess args ที่ถูก echo กลับ)
      await cloneCommit({
        repoFullName: "unused/unused",
        commitSha: "a".repeat(40),
        token: secretToken,
        destDir,
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        remoteUrl: "https://127.0.0.1:1/owner/repo.git",
        onLog: (line) => logs.push(line),
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    // token ไม่ปรากฏใน log บรรทัดไหนเลย (redactString ครอบ URL credentials และ ghs_* โดยตรง)
    const fullLog = logs.join("\n");
    expect(fullLog).not.toContain(secretToken);
    // error message ของ AppError เองก็ต้องไม่มี token (stderr ผ่าน redactString ก่อนใส่ error message)
    expect((caught as AppError).message).not.toContain(secretToken);
  });
});
