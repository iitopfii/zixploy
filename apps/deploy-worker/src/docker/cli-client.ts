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
  DockerStatsEntry,
  ImageInspect,
  ImageSummary,
  VolumeInspect,
  VolumeSummary,
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
    // Named volume mounts — Docker volume ต้องมีอยู่แล้วก่อน createContainer (Phase 7)
    for (const v of params.volumes ?? []) {
      // --mount format: type=volume,source=<name>,target=<path>[,readonly]
      // ห้ามใช้ --volume/-v เพราะ --mount ชัดเจนกว่า และไม่สร้าง anonymous volume โดยไม่ตั้งใจ
      const spec = `type=volume,source=${v.dockerName},target=${v.mountPath}${v.readOnly ? ",readonly" : ""}`;
      args.push("--mount", spec);
    }

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

  /**
   * inspect หลาย container ในคำสั่งเดียว — Phase 9 (monitoring)
   *
   * loop เรียก inspectContainer() ทีละตัวจะ spawn subprocess เท่าจำนวน container ทุกรอบเก็บ
   * (ทุก 15 วิ) ซึ่งเปลืองเกินจำเป็น — `docker inspect a b c` คืน JSON array เดียวจบ
   *
   * ID ที่ไม่มีอยู่จะถูกข้ามไปเงียบ ๆ (docker คืน exit code != 0 แต่ยัง print array ของตัวที่เจอ)
   * — คืนเฉพาะตัวที่ inspect ได้ ผู้เรียกจับคู่กลับด้วย Id เอง
   */
  async inspectContainers(containerIds: string[]): Promise<ContainerInspect[]> {
    if (containerIds.length === 0) return [];
    const result = await this.exec(["inspect", ...containerIds]);
    try {
      const parsed = JSON.parse(result.stdout) as unknown[];
      return Array.isArray(parsed) ? (parsed as ContainerInspect[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * `docker stats --no-stream` ของ container ที่ระบุ — Phase 9 (monitoring)
   *
   * --no-stream ให้ docker สุ่มตัวอย่าง CPU สองครั้งห่างกัน ~1 วิ แล้วจบ (คำสั่งนี้จึงช้ากว่า
   * คำสั่ง docker อื่น ๆ อย่างเห็นได้ชัด — เป็นเหตุผลที่ sampleIntervalMs ต้องไม่ต่ำกว่านั้นมาก)
   *
   * ส่งเฉพาะ container ที่ running: ตัวที่หยุดแล้วจะรายงาน "--" ทุก field ซึ่ง parse ไม่ได้อยู่ดี
   * คืน [] เมื่อ daemon มีปัญหา (ไม่ throw) — metrics ขาดหนึ่งรอบดีกว่า loop ตาย
   */
  async statsByIds(containerIds: string[]): Promise<DockerStatsEntry[]> {
    if (containerIds.length === 0) return [];
    try {
      const result = await this.exec([
        "stats",
        "--no-stream",
        "--format",
        "{{json .}}",
        ...containerIds,
      ]);
      if (result.code !== 0) return [];
      return result.stdout
        .split("\n")
        .filter((line) => line.trim())
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as DockerStatsEntry];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
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

  async listImagesByLabel(labels: Record<string, string>): Promise<ImageSummary[]> {
    const args = ["images", "--format", "{{json .}}"];
    for (const [k, v] of Object.entries(labels)) args.push("--filter", `label=${k}=${v}`);
    const result = await this.exec(args);
    if (result.code !== 0) {
      throw new AppError("DOCKER_UNAVAILABLE", `docker images ล้มเหลว: ${truncate(result.stderr)}`);
    }
    return result.stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as ImageSummary);
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

  /**
   * อ่าน log ของ container ตั้งแต่ timestamp ที่กำหนด (runtime log poller — Phase 6 M4)
   *
   * ใช้ --timestamps เพื่อรับ timestamp ต่อบรรทัด (RFC3339Nano format ของ Docker)
   * ใช้ --since <sinceTs> เพื่อ incremental pull — ไม่ดึง log ทั้งหมดทุกรอบ
   * คืน [] ถ้า container ไม่มีอยู่ (graceful — ไม่ throw)
   *
   * @param containerId Docker container ID หรือชื่อ container
   * @param sinceMs timestamp (ms) สำหรับ --since; 0 = ทุก log
   * @param tail จำนวนบรรทัดสูงสุดที่ดึงต่อครั้ง (ป้องกัน memory spike ถ้า log ยาวมาก)
   */
  async fetchLogs(
    containerId: string,
    sinceMs: number,
    tail = 200,
  ): Promise<Array<{ stream: "stdout" | "stderr"; line: string; loggedAt: number }>> {
    const args = ["logs", "--timestamps", "--tail", String(tail)];
    if (sinceMs > 0) {
      // docker --since รับ RFC3339 หรือ relative (10m, 1h) — ใช้ ISO string ตรงๆ
      args.push("--since", new Date(sinceMs).toISOString());
    }
    args.push(containerId);

    const result = await this.exec(args);
    if (result.code !== 0 && isNotFoundError(result.stderr)) return [];

    // docker logs: stdout → result.stdout, stderr → result.stderr
    // แต่ละบรรทัดขึ้นต้นด้วย RFC3339Nano timestamp จาก --timestamps
    // เช่น "2024-01-15T12:34:56.789012345Z hello world\n"
    const parsed: Array<{ stream: "stdout" | "stderr"; line: string; loggedAt: number }> = [];

    function parseLines(raw: string, stream: "stdout" | "stderr") {
      for (const rawLine of raw.split("\n")) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        // timestamp ตัวแรกคั่นด้วย space
        const spaceIdx = trimmed.indexOf(" ");
        if (spaceIdx < 0) {
          parsed.push({ stream, line: trimmed, loggedAt: Date.now() });
          continue;
        }
        const tsStr = trimmed.slice(0, spaceIdx);
        const line = trimmed.slice(spaceIdx + 1);
        const loggedAt = new Date(tsStr).getTime();
        parsed.push({ stream, line, loggedAt: Number.isNaN(loggedAt) ? Date.now() : loggedAt });
      }
    }

    parseLines(result.stdout, "stdout");
    parseLines(result.stderr, "stderr");

    // เรียงตาม loggedAt เพราะ docker ส่ง stdout + stderr แยกกัน ลำดับอาจคละกัน
    parsed.sort((a, b) => a.loggedAt - b.loggedAt);
    return parsed;
  }

  // ---------------------------------------------------------------------------
  // Volume operations (Phase 7)
  // ---------------------------------------------------------------------------

  /**
   * สร้าง Docker named volume (idempotent — ถ้า volume มีอยู่แล้ว error ไม่ถูก throw)
   * Worker เรียกก่อน createContainer ทุกครั้งเพื่อ ensure volume exists
   */
  async createVolume(params: {
    name: string;
    driver: string;
    labels?: Record<string, string>;
  }): Promise<void> {
    const args = ["volume", "create", "--driver", params.driver];
    for (const [k, v] of Object.entries(params.labels ?? {})) {
      args.push("--label", `${k}=${v}`);
    }
    args.push(params.name);

    const result = await this.exec(args);
    if (result.code !== 0) {
      // docker volume create โดยปกติ idempotent — ถ้า fail จริงถือว่า error สำคัญ
      throw new AppError(
        "VOLUME_CREATE_FAILED",
        `docker volume create ล้มเหลว: ${truncate(result.stderr)}`,
      );
    }
  }

  /** ดึงข้อมูล Docker volume — คืน null ถ้าไม่มีอยู่ */
  async inspectVolume(name: string): Promise<VolumeInspect | null> {
    const result = await this.exec(["volume", "inspect", "--format", "{{json .}}", name]);
    if (result.code !== 0) return null;
    try {
      return JSON.parse(result.stdout.trim()) as VolumeInspect;
    } catch {
      return null;
    }
  }

  /**
   * ลบ Docker named volume
   * คืนปกติถ้า volume ไม่มีอยู่แล้ว (idempotent)
   * Throw VOLUME_IN_USE ถ้า container ยังใช้ volume อยู่
   */
  async removeVolume(name: string, opts: { force?: boolean } = {}): Promise<void> {
    const args = ["volume", "rm"];
    if (opts.force) args.push("-f");
    args.push(name);

    const result = await this.exec(args);
    if (result.code !== 0) {
      if (isNotFoundError(result.stderr)) return; // idempotent
      // docker volume rm ล้มเหลวเพราะ container ยังใช้ volume อยู่
      if (result.stderr.toLowerCase().includes("in use")) {
        throw new AppError("VOLUME_IN_USE", `volume ${name} ยังมี container ใช้อยู่ ลบไม่ได้`);
      }
      throw new AppError(
        "DOCKER_UNAVAILABLE",
        `docker volume rm ล้มเหลว: ${truncate(result.stderr)}`,
      );
    }
  }

  /** List Docker volumes ที่ตรงกับ labels ที่กำหนด (ใช้ใน orphan reconciler) */
  async listVolumesByLabel(labels: Record<string, string>): Promise<VolumeSummary[]> {
    const args = ["volume", "ls", "--format", "json"];
    for (const [k, v] of Object.entries(labels)) {
      args.push("--filter", `label=${k}=${v}`);
    }

    const result = await this.exec(args);
    if (result.code !== 0) return [];

    return result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as VolumeSummary];
        } catch {
          return [];
        }
      });
  }
}
