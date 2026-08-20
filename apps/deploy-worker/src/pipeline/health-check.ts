/**
 * Health check runner — poll container จนกว่าจะ healthy หรือหมด retries
 *
 * ตรวจสอบจริงระหว่าง implement: container บน user-defined bridge network (zixploy-proxy)
 * เข้าถึงได้โดยตรงผ่าน IP จาก host **เฉพาะบน Linux** (production target — docs/conventions.md)
 * — บน Docker Desktop/Windows (dev) container IP ไม่ reachable จาก host โดยตรงเพราะ Docker
 * Desktop รัน Engine ใน Linux VM แยก ไม่ได้แชร์ network stack กับ host เหมือน native Linux
 * ฟังก์ชันนี้จึงฉีด fetchFn เข้ามาได้เพื่อเทสต์ได้อย่างอิสระจาก platform — ของจริงใช้ global fetch
 * ซึ่งจะทำงานถูกต้องบน production (Linux) ตามที่ระบบออกแบบไว้
 *
 * ไม่ publish container port ไปยัง host เลย (health check เข้าถึงผ่าน internal network เท่านั้น)
 * ตรงตามหลัก "ไม่ expose container โดยตรง" — Traefik (Phase 5) จะเป็นทางเข้าเดียวจากภายนอก
 */

import { AppError } from "@zixploy/shared";
import type { DockerCliClient } from "../docker/cli-client";

/** RestartCount เกินนี้ระหว่าง health check ถือว่า crash-loop — fail เร็วไม่ต้องรอครบ retries */
const CRASH_LOOP_RESTART_THRESHOLD = 3;

/**
 * ไม่ได้ตั้ง health check path → เฝ้าดู container ต่อเนื่องนานเท่านี้ก่อนนับว่าสำเร็จ
 *
 * เดิมเช็ค Running ครั้งเดียวแล้วผ่านเลย — แอปที่ start ติดแล้ว crash ใน 2-3 วินาที (env ขาด,
 * config ผิด) ถูกนับเป็น deploy สำเร็จ: container เก่าถูกถอด, image เก่าถูก retention เก็บกวาด,
 * เว็บล่มโดย rollback ไม่ได้ (เหตุการณ์จริง 2026-08-20) — 10 วินาทีจับ crash-on-boot ได้เกือบหมด
 * โดยแลกกับ deploy ช้าลงเพียงเล็กน้อยเฉพาะ project ที่ไม่ตั้ง health check path
 */
const NO_HTTP_STABILITY_WINDOW_MS = 10_000;
const NO_HTTP_STABILITY_PROBE_MS = 2_000;

export interface HealthCheckParams {
  docker: DockerCliClient;
  containerId: string;
  networkName: string;
  internalPort: number | null;
  healthCheckPath: string | null;
  intervalSec: number;
  timeoutSec: number;
  retries: number;
  signal: AbortSignal;
  /** ฉีดสำหรับเทสต์ — default คือ global fetch */
  fetchFn?: typeof fetch;
  /** ฉีดสำหรับเทสต์ — ย่นระยะเฝ้าดูของ fallback แบบไม่มี HTTP check */
  stabilityWindowMs?: number;
  stabilityProbeMs?: number;
  /** log ลง deploy log (optional — ผู้เรียกส่ง redacted logger มา) */
  onLog?: (line: string) => void;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

async function probeHttp(
  fetchFn: typeof fetch,
  ip: string,
  port: number,
  path: string,
  timeoutSec: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const res = await fetchFn(`http://${ip}:${port}${path}`, { signal: controller.signal });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ไม่ตั้ง health check path — ยืนยันว่า container "อยู่รอดต่อเนื่อง" ตลอดช่วงเฝ้าดูก่อนนับว่าสำเร็จ
 *
 * container ที่เพิ่ง start ต้อง Running ตั้งแต่แรก — เห็นไม่ Running หรือ RestartCount ขยับเมื่อไหร่
 * แปลว่า process ตายไปแล้วอย่างน้อยหนึ่งครั้ง (crash-on-boot) → fail ทันที ไม่ต้องรอครบ window
 */
async function assertStableWithoutHttpCheck(
  docker: DockerCliClient,
  containerId: string,
  windowMs: number,
  probeMs: number,
  signal: AbortSignal,
  onLog?: (line: string) => void,
): Promise<void> {
  onLog?.(
    `[health] ไม่ได้ตั้ง health check path — เฝ้าดู container ${Math.round(windowMs / 1000)} วิ ` +
      "ให้แน่ใจว่าไม่ crash หลัง start (ตั้ง health check path ใน settings เพื่อการตรวจที่แม่นยำกว่า)",
  );
  const deadline = Date.now() + windowMs;
  for (;;) {
    if (signal.aborted) {
      throw new AppError("HEALTH_CHECK_FAILED", "health check ถูกยกเลิกระหว่างทำงาน");
    }
    const inspect = await docker.inspectContainer(containerId);
    if (!inspect) {
      throw new AppError("HEALTH_CHECK_FAILED", "container หายไประหว่างเฝ้าดูหลัง start");
    }
    if (inspect.RestartCount > 0) {
      throw new AppError(
        "CONTAINER_CRASH_LOOP",
        `container crash แล้วถูก restart ${inspect.RestartCount} ครั้งหลัง start — ` +
          "ดู runtime log เพื่อหาสาเหตุ (ที่พบบ่อย: env ขาด, config ผิด, port ชน)",
      );
    }
    if (!inspect.State.Running) {
      throw new AppError(
        "HEALTH_CHECK_FAILED",
        "container หยุดทำงานหลัง start — ดู runtime log เพื่อหาสาเหตุ",
      );
    }
    if (Date.now() >= deadline) return;
    await sleep(probeMs, signal);
  }
}

/**
 * Poll จนกว่า container จะ healthy หรือหมด retries
 * - ไม่ตั้ง healthCheckPath/internalPort → fallback: เฝ้าดูว่า Running ต่อเนื่องตลอด stability window
 *   (เดิมเช็คครั้งเดียว — ปล่อย crash-on-boot ผ่านเป็น succeeded จนเว็บล่มแบบ rollback ไม่ได้)
 * - ตั้งไว้ → HTTP GET ผ่าน container's network IP ซ้ำจนสำเร็จหรือหมด retries
 * - RestartCount เกิน threshold ระหว่างทาง → CONTAINER_CRASH_LOOP ทันที (ไม่รอครบ retries)
 * - cancel_requested (ผ่าน signal) → หยุด poll ทันที โยน error ทั่วไปให้ caller (pipeline) จัดการ
 */
export async function waitForHealthy(params: HealthCheckParams): Promise<void> {
  const {
    docker,
    containerId,
    networkName,
    internalPort,
    healthCheckPath,
    intervalSec,
    timeoutSec,
    retries,
    signal,
    fetchFn = fetch,
    stabilityWindowMs = NO_HTTP_STABILITY_WINDOW_MS,
    stabilityProbeMs = NO_HTTP_STABILITY_PROBE_MS,
    onLog,
  } = params;

  const hasHttpCheck = internalPort != null && !!healthCheckPath;

  if (!hasHttpCheck) {
    await assertStableWithoutHttpCheck(
      docker,
      containerId,
      stabilityWindowMs,
      stabilityProbeMs,
      signal,
      onLog,
    );
    return;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (signal.aborted) {
      throw new AppError("HEALTH_CHECK_FAILED", "health check ถูกยกเลิกระหว่างทำงาน");
    }

    const inspect = await docker.inspectContainer(containerId);
    if (!inspect) {
      throw new AppError("HEALTH_CHECK_FAILED", "container หายไประหว่าง health check");
    }
    if (inspect.RestartCount >= CRASH_LOOP_RESTART_THRESHOLD) {
      throw new AppError(
        "CONTAINER_CRASH_LOOP",
        `container restart ${inspect.RestartCount} ครั้งระหว่าง health check`,
      );
    }

    if (inspect.State.Running) {
      const ip = inspect.NetworkSettings.Networks[networkName]?.IPAddress;
      if (ip) {
        // biome-ignore lint/style/noNonNullAssertion: hasHttpCheck guarantees ทั้งคู่ไม่ null
        const healthy = await probeHttp(fetchFn, ip, internalPort!, healthCheckPath!, timeoutSec);
        if (healthy) return;
      }
    }

    await sleep(intervalSec * 1000, signal);
  }

  throw new AppError("HEALTH_CHECK_FAILED", `health check ไม่ผ่านหลัง ${retries} ครั้ง`);
}

export interface ContainerHealthParams {
  docker: DockerCliClient;
  containerId: string;
  intervalSec: number;
  timeoutSec: number;
  retries: number;
  signal: AbortSignal;
}

/**
 * รอ Docker-native healthcheck ของ container ให้เป็น "healthy" — ใช้ตอน gate dependent ที่ระบุ
 * depends_on condition='healthy' (Phase 18 · F) โดยอ่าน State.Health.Status ตรง ๆ (Docker รัน
 * healthcheck เองในคอนเทนเนอร์ จึงไม่ต้องให้ worker เข้าถึง network ของ container นั้น)
 *
 * คืนค่า:
 *  - "healthy"       → dependency พร้อม (start dependent ต่อได้)
 *  - "no-healthcheck"→ container ไม่มี HEALTHCHECK เลย (State.Health หายทั้ง ๆ ที่ running) — ตัดสิน
 *                       ไม่ได้ ให้ caller fallback เป็น 'started' พร้อม log เตือน (ไม่ throw กัน deploy ค้าง)
 * throw:
 *  - CONTAINER_CRASH_LOOP  ถ้า restart หลายครั้ง
 *  - HEALTH_CHECK_FAILED   ถ้า unhealthy ยืดเยื้อ/หมด retries/ถูกยกเลิก/container หาย
 */
export async function waitForContainerHealthy(
  params: ContainerHealthParams,
): Promise<"healthy" | "no-healthcheck"> {
  const { docker, containerId, intervalSec, timeoutSec, retries, signal } = params;
  // budget รอบ = retries*(interval+timeout) แต่อย่างน้อยกันไว้ให้พอ container เพิ่ง start
  const maxAttempts = Math.max(retries, 1) + Math.ceil(timeoutSec / Math.max(intervalSec, 1));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal.aborted) {
      throw new AppError("HEALTH_CHECK_FAILED", "รอ dependency healthy ถูกยกเลิกระหว่างทำงาน");
    }
    const inspect = await docker.inspectContainer(containerId);
    if (!inspect) {
      throw new AppError("HEALTH_CHECK_FAILED", "dependency container หายไประหว่างรอ healthy");
    }
    if (inspect.RestartCount >= CRASH_LOOP_RESTART_THRESHOLD) {
      throw new AppError(
        "CONTAINER_CRASH_LOOP",
        `dependency container restart ${inspect.RestartCount} ครั้งระหว่างรอ healthy`,
      );
    }
    const status = inspect.State.Health?.Status;
    if (status === undefined) {
      // ไม่มี HEALTHCHECK — ตัดสิน healthy ไม่ได้ (แต่ container running อยู่) ให้ caller ตัดสินใจ
      if (inspect.State.Running) return "no-healthcheck";
    } else {
      if (status === "healthy") return "healthy";
      if (status === "unhealthy" && (inspect.State.Health?.FailingStreak ?? 0) >= 5) {
        throw new AppError("HEALTH_CHECK_FAILED", "dependency ตอบ healthcheck ไม่ผ่านติดต่อกันหลายครั้ง");
      }
    }
    await sleep(intervalSec * 1000, signal);
  }
  throw new AppError("HEALTH_CHECK_FAILED", "dependency ไม่ healthy ภายในเวลาที่กำหนด");
}
