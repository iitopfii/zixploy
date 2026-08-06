/**
 * Docker Engine access ผ่าน `docker` CLI subprocess — ไม่ใช้ raw Engine API over socket/pipe
 *
 * เหตุผล (ตรวจสอบจริงระหว่าง implement): Docker Desktop บน Windows ใช้ named pipe
 * (npipe://./pipe/docker_engine) โดย default ไม่ใช่ TCP — Bun's fetch ต่อ named pipe ตรง ๆ ไม่ได้
 * การเรียกผ่าน `docker` CLI ให้ CLI จัดการ transport เอง (npipe บน Windows, unix socket บน Linux
 * prod) ผ่าน context resolution — โค้ดเดียวกันทำงานได้ทั้งสอง platform โดยไม่ต้อง branch
 *
 * ทุก args เป็น array เสมอ ไม่ต่อ shell string (docs/conventions.md)
 * ทุก container create ผ่าน safety.ts denylist ก่อนเสมอ
 */

import { AppError } from "@zixploy/shared";
import { assertContainerConfigSafe, assertDockerArgsSafe } from "./safety";
import type {
  ContainerCreateParams,
  ContainerInspect,
  ContainerSummary,
  ImageInspect,
} from "./types";

export interface DockerClientOptions {
  /** override DOCKER_HOST ให้ subprocess — ไม่ตั้ง = ใช้ ambient docker context ของเครื่องปกติ */
  dockerHost?: string;
  /** timeout ต่อคำสั่งหนึ่งครั้ง (ms) — ไม่รวม buildImage ซึ่งมี timeout ของตัวเอง */
  commandTimeoutMs?: number;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function truncate(text: string, max = 400): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function isNotFoundError(stderr: string): boolean {
  return /no such (container|image|object|network)/i.test(stderr);
}

const PIPE_DRAIN_GRACE_MS = 2_000;

/** อ่าน stream แบบมี grace period จำกัด — ไม่ค้างเด็ดขาดแม้ pipe ไม่ปิดหลัง process ถูก kill */
async function readWithGracePeriod(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return Promise.race([
    new Response(stream).text(),
    new Promise<string>((resolve) => setTimeout(() => resolve(""), PIPE_DRAIN_GRACE_MS)),
  ]);
}

export class DockerCliClient {
  constructor(private readonly options: DockerClientOptions = {}) {}

  private async exec(args: string[]): Promise<ExecResult> {
    const env = this.options.dockerHost
      ? { ...process.env, DOCKER_HOST: this.options.dockerHost }
      : process.env;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.commandTimeoutMs ?? 30_000);
    try {
      const proc = Bun.spawn(["docker", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env,
        signal: controller.signal,
      });
      // await proc.exited ก่อนอ่าน pipe เสมอ — พิสูจน์แล้วจริงใน buildkit.ts ว่าถ้าอ่าน pipe
      // ก่อน (หรือพร้อมกับ) proc.exited แล้ว process ถูก kill กลางทาง pipe อาจไม่ส่ง EOF เลย
      // ค้างตลอดไป แม้คำสั่ง docker ธรรมดา (ไม่ใช่ buildx) จะไม่เจอปัญหานี้ในเทสต์ที่ผ่านมา
      // ก็ใช้ pattern เดียวกันเพื่อความสม่ำเสมอและกัน edge case ในอนาคต
      const code = await proc.exited;
      const [stdout, stderr] = await Promise.all([
        readWithGracePeriod(proc.stdout),
        readWithGracePeriod(proc.stderr),
      ]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }

  /** false (ไม่ throw) เมื่อ daemon ไม่พร้อมใช้งานไม่ว่ากรณีใด */
  async ping(): Promise<boolean> {
    try {
      const result = await this.exec(["version", "--format", "{{.Server.Version}}"]);
      return result.code === 0;
    } catch {
      return false;
    }
  }

  async ensureNetwork(name: string): Promise<{ networkId: string }> {
    const inspect = await this.exec(["network", "inspect", name, "--format", "{{.Id}}"]);
    if (inspect.code === 0) {
      return { networkId: inspect.stdout.trim() };
    }
    const create = await this.exec(["network", "create", name]);
    if (create.code !== 0) {
      throw new AppError(
        "DOCKER_UNAVAILABLE",
        `docker network create ล้มเหลว: ${truncate(create.stderr)}`,
      );
    }
    return { networkId: create.stdout.trim() };
  }

  async createContainer(params: ContainerCreateParams): Promise<{ containerId: string }> {
    assertContainerConfigSafe(params);

    const args = [
      "create",
      "--name",
      params.name,
      "--network",
      params.networkName,
      "--restart",
      params.restartPolicy,
      "--pids-limit",
      String(params.pidsLimit ?? 512),
    ];
    for (const [k, v] of Object.entries(params.labels)) args.push("--label", `${k}=${v}`);
    if (params.env) {
      for (const [k, v] of Object.entries(params.env)) args.push("-e", `${k}=${v}`);
    }
    if (params.cpuLimit != null) args.push("--cpus", String(params.cpuLimit));
    if (params.memoryLimitMb != null) args.push("--memory", `${params.memoryLimitMb}m`);

    assertDockerArgsSafe(args);

    args.push(params.image);
    if (params.cmd) args.push(...params.cmd);

    const result = await this.exec(args);
    if (result.code !== 0) {
      throw new AppError("DOCKER_UNAVAILABLE", `docker create ล้มเหลว: ${truncate(result.stderr)}`);
    }
    return { containerId: result.stdout.trim() };
  }

  async startContainer(containerId: string): Promise<void> {
    const result = await this.exec(["start", containerId]);
    if (result.code !== 0) {
      throw new AppError("DOCKER_UNAVAILABLE", `docker start ล้มเหลว: ${truncate(result.stderr)}`);
    }
  }

  async stopContainer(containerId: string, opts: { timeoutSec?: number } = {}): Promise<void> {
    const result = await this.exec(["stop", "-t", String(opts.timeoutSec ?? 10), containerId]);
    if (result.code !== 0 && !isNotFoundError(result.stderr)) {
      throw new AppError("DOCKER_UNAVAILABLE", `docker stop ล้มเหลว: ${truncate(result.stderr)}`);
    }
  }

  /** idempotent — "no such container" ไม่ถือเป็น error (ใช้ซ้ำได้ปลอดภัยตอน retry) */
  async removeContainer(containerId: string, opts: { force?: boolean } = {}): Promise<void> {
    const args = ["rm"];
    if (opts.force) args.push("-f");
    args.push(containerId);
    const result = await this.exec(args);
    if (result.code !== 0 && !isNotFoundError(result.stderr)) {
      throw new AppError("DOCKER_UNAVAILABLE", `docker rm ล้มเหลว: ${truncate(result.stderr)}`);
    }
  }

  async inspectContainer(containerId: string): Promise<ContainerInspect | null> {
    const result = await this.exec(["inspect", containerId]);
    if (result.code !== 0) return null;
    try {
      const parsed = JSON.parse(result.stdout) as unknown[];
      return (parsed[0] as ContainerInspect | undefined) ?? null;
    } catch {
      return null;
    }
  }

  async listContainersByLabel(labels: Record<string, string>): Promise<ContainerSummary[]> {
    const args = ["ps", "-a", "--format", "{{json .}}"];
    for (const [k, v] of Object.entries(labels)) args.push("--filter", `label=${k}=${v}`);
    const result = await this.exec(args);
    if (result.code !== 0) {
      throw new AppError("DOCKER_UNAVAILABLE", `docker ps ล้มเหลว: ${truncate(result.stderr)}`);
    }
    return result.stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as ContainerSummary);
  }

  /** idempotent — "no such image" ไม่ถือเป็น error */
  async removeImage(imageRef: string, opts: { force?: boolean } = {}): Promise<void> {
    const args = ["rmi"];
    if (opts.force) args.push("-f");
    args.push(imageRef);
    const result = await this.exec(args);
    if (result.code !== 0 && !isNotFoundError(result.stderr)) {
      throw new AppError("DOCKER_UNAVAILABLE", `docker rmi ล้มเหลว: ${truncate(result.stderr)}`);
    }
  }

  async inspectImage(imageRef: string): Promise<ImageInspect | null> {
    const result = await this.exec(["image", "inspect", imageRef]);
    if (result.code !== 0) return null;
    try {
      const parsed = JSON.parse(result.stdout) as unknown[];
      return (parsed[0] as ImageInspect | undefined) ?? null;
    } catch {
      return null;
    }
  }

  async connectNetwork(networkName: string, containerId: string): Promise<void> {
    const result = await this.exec(["network", "connect", networkName, containerId]);
    if (result.code !== 0 && !/already exists|already connected/i.test(result.stderr)) {
      throw new AppError(
        "DOCKER_UNAVAILABLE",
        `docker network connect ล้มเหลว: ${truncate(result.stderr)}`,
      );
    }
  }

  async disconnectNetwork(networkName: string, containerId: string): Promise<void> {
    const result = await this.exec(["network", "disconnect", networkName, containerId]);
    if (result.code !== 0 && !isNotFoundError(result.stderr)) {
      throw new AppError(
        "DOCKER_UNAVAILABLE",
        `docker network disconnect ล้มเหลว: ${truncate(result.stderr)}`,
      );
    }
  }
}
