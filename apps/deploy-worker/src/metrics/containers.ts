/**
 * Container resource metrics ราย project — Phase 9 (server monitoring)
 *
 * เก็บ 3 คำสั่ง docker ต่อรอบ ไม่ขึ้นกับจำนวน container:
 *   1. docker ps    — หา container ที่ platform.managed=true พร้อม label project_id
 *   2. docker inspect (batch) — RestartCount, State.Running, HostConfig.Memory (limit จริง)
 *   3. docker stats  (batch) — CPU%/memory ปัจจุบัน เฉพาะตัวที่ running
 *
 * เหตุที่ต้องใช้ทั้ง inspect และ stats: stats รายงาน memory limit ของ container ที่ไม่ได้จำกัด
 * เป็นขนาด RAM ทั้งเครื่อง แยกไม่ออกจาก "ตั้ง limit เท่า RAM เครื่องพอดี" — HostConfig.Memory
 * ให้ค่าที่ตั้งไว้จริง (0 = ไม่จำกัด) ส่วน RestartCount ไม่มีใน stats เลย
 *
 * fail-soft ทุกจุด: docker มีปัญหา → คืน [] ให้ข้ามรอบ ไม่ throw ให้ loop ตาย
 */

import { LABELS } from "@zixploy/shared";
import type { DockerCliClient } from "../docker/cli-client";
import { parseLabelString } from "../docker/labels";
import type { ContainerInspect } from "../docker/types";

export interface ContainerSample {
  projectId: string;
  containerId: string;
  cpuPercent: number;
  memUsedBytes: number;
  /** 0 = ไม่ได้ตั้ง memory limit */
  memLimitBytes: number;
  restartCount: number;
  running: boolean;
}

/** "0.05%" → 0.05 — คืน null เมื่อเป็น "--" (container หยุดแล้ว) หรือ format ไม่รู้จัก */
export function parsePercent(raw: string): number | null {
  const match = /^([\d.]+)\s*%$/.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

const UNIT_MULTIPLIERS: Record<string, number> = {
  b: 1,
  // Docker ใช้ทั้งฐาน 1000 (kB/MB จาก HumanSize) และฐาน 1024 (KiB/MiB จาก BytesSize)
  // แล้วแต่ field — รองรับทั้งคู่ให้ตรงตามความหมายจริงของแต่ละหน่วย
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

/** "19.3MiB" → 20238336 — คืน null เมื่อ parse ไม่ได้ */
export function parseBytes(raw: string): number | null {
  const match = /^([\d.]+)\s*([a-zA-Z]+)$/.exec(raw.trim());
  if (!match) return null;
  const value = Number(match[1]);
  const multiplier = UNIT_MULTIPLIERS[(match[2] as string).toLowerCase()];
  if (!Number.isFinite(value) || value < 0 || multiplier === undefined) return null;
  return Math.round(value * multiplier);
}

/** "19.3MiB / 7.772GiB" → { usedBytes, limitBytes } */
export function parseMemUsage(raw: string): { usedBytes: number; limitBytes: number } | null {
  const parts = raw.split("/");
  if (parts.length !== 2) return null;
  const used = parseBytes(parts[0] as string);
  const limit = parseBytes(parts[1] as string);
  if (used === null || limit === null) return null;
  return { usedBytes: used, limitBytes: limit };
}

interface ManagedContainer {
  containerId: string;
  projectId: string;
}

/**
 * เลือก container ตัวแทนของแต่ละ project — หนึ่ง project มีได้หลาย container พร้อมกันจริง
 * (ตัวเก่ายังไม่ถูก cleanup หลัง deploy ใหม่ หรือ candidate ที่ activate ไม่สำเร็จค้างอยู่)
 *
 * เลือกตัวที่ running ก่อนเสมอ ถ้าไม่มีเลยจึงใช้ตัวแรกที่เจอ (docker ps เรียงใหม่→เก่า
 * ตัวแรกจึงเป็นตัวล่าสุด) — สะท้อน "container ที่ให้บริการอยู่" ซึ่งเป็นสิ่งที่กราฟควรบอก
 */
export function pickPerProject(
  managed: ManagedContainer[],
  runningIds: ReadonlySet<string>,
): Map<string, string> {
  const chosen = new Map<string, string>();
  for (const c of managed) {
    const current = chosen.get(c.projectId);
    if (current === undefined) {
      chosen.set(c.projectId, c.containerId);
      continue;
    }
    // แทนที่ตัวเดิมเฉพาะเมื่อตัวเดิมไม่ running แต่ตัวใหม่ running
    if (!runningIds.has(current) && runningIds.has(c.containerId)) {
      chosen.set(c.projectId, c.containerId);
    }
  }
  return chosen;
}

export async function collectContainerSamples(docker: DockerCliClient): Promise<ContainerSample[]> {
  let managed: ManagedContainer[];
  try {
    const summaries = await docker.listContainersByLabel({ [LABELS.managed]: "true" });
    managed = summaries.flatMap((s) => {
      const projectId = parseLabelString(s.Labels)[LABELS.projectId];
      // container ที่ managed แต่ไม่มี project_id label = orphan — reconciler รายงานแยกอยู่แล้ว
      return projectId ? [{ containerId: s.ID, projectId }] : [];
    });
  } catch {
    return [];
  }

  if (managed.length === 0) return [];

  const inspects = await docker.inspectContainers(managed.map((c) => c.containerId));
  const byId = new Map<string, ContainerInspect>();
  for (const info of inspects) {
    // docker ps ให้ ID สั้น 12 ตัว แต่ inspect คืน Id เต็ม 64 ตัว — เก็บทั้งสองแบบให้จับคู่ได้
    byId.set(info.Id, info);
    byId.set(info.Id.slice(0, 12), info);
  }

  const runningIds = new Set(
    managed.map((c) => c.containerId).filter((id) => byId.get(id)?.State.Running === true),
  );
  const chosen = pickPerProject(managed, runningIds);

  const statsTargets = [...chosen.values()].filter((id) => runningIds.has(id));
  const stats = await docker.statsByIds(statsTargets);

  const statsById = new Map<string, { cpuPercent: number; usedBytes: number }>();
  for (const entry of stats) {
    const cpuPercent = parsePercent(entry.CPUPerc);
    const mem = parseMemUsage(entry.MemUsage);
    if (cpuPercent === null || !mem) continue;
    statsById.set(entry.ID, { cpuPercent, usedBytes: mem.usedBytes });
    statsById.set(entry.ID.slice(0, 12), { cpuPercent, usedBytes: mem.usedBytes });
  }

  const samples: ContainerSample[] = [];
  for (const [projectId, containerId] of chosen) {
    const info = byId.get(containerId);
    const running = runningIds.has(containerId);
    const stat = statsById.get(containerId);

    // running แต่ไม่มี stat = docker stats ไม่ทันหรือ container ตายระหว่างรอบ — ข้ามไป
    // ดีกว่าเก็บ 0% ซึ่งอ่านเหมือน "ว่างสนิท" ทั้งที่แค่วัดไม่ได้
    if (running && !stat) continue;

    samples.push({
      projectId,
      containerId,
      cpuPercent: stat?.cpuPercent ?? 0,
      memUsedBytes: stat?.usedBytes ?? 0,
      memLimitBytes: Math.max(0, info?.HostConfig?.Memory ?? 0),
      restartCount: Math.max(0, info?.RestartCount ?? 0),
      running,
    });
  }

  return samples;
}
