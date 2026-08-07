/**
 * Host resource metrics — Phase 9 (server monitoring)
 *
 * อ่านจาก /proc ของ **host** ไม่ใช่ของ container: Docker ไม่ได้ namespace /proc/stat,
 * /proc/meminfo หรือ /proc/loadavg (ไม่มี lxcfs) ค่าที่อ่านได้จึงเป็นของทั้งเครื่องตามที่ต้องการ
 * — ตรงข้ามกับ cgroup files (/sys/fs/cgroup/...) ที่จะให้ค่าของ container ตัวเอง
 *
 * ดิสก์ใช้ `df` บน path ที่เป็น Docker volume mount: volume ถูก bind มาจาก /var/lib/docker/volumes
 * บน host ดังนั้น df จึงรายงาน filesystem ของ host ที่เก็บ image/volume/workspace จริง
 * (ถ้า df บน "/" จะได้ overlay ของ container เองซึ่งไม่มีความหมาย)
 *
 * ทุกฟังก์ชัน fail-soft: อ่านไม่ได้ → คืน null ให้ผู้เรียกข้ามรอบนั้นไป ไม่ throw ให้ loop ตาย
 */

import { readFile } from "node:fs/promises";

export interface HostSample {
  ts: number;
  cpuPercent: number;
  cpuCount: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  load1: number;
  load5: number;
  load15: number;
}

/** ผลรวม jiffies จาก /proc/stat บรรทัด "cpu " — ใช้เทียบ delta ระหว่างสองรอบ */
export interface CpuSnapshot {
  /** ผลรวมทุก field (busy + idle) */
  total: number;
  /** idle + iowait — เวลาที่ CPU ไม่ได้ทำงานจริง */
  idle: number;
  /** จำนวน core ที่นับได้จากบรรทัด cpu0..cpuN */
  count: number;
}

/**
 * แยกบรรทัด "cpu  user nice system idle iowait irq softirq steal guest guest_nice"
 *
 * guest/guest_nice ไม่ถูกนับซ้ำเพราะเคอร์เนลรวมไว้ใน user/nice อยู่แล้ว — ใช้แค่ 8 field แรก
 * ตามที่ procfs(5) ระบุ (นับ guest ซ้ำจะทำให้ total เกินจริงและ cpu% ต่ำกว่าความเป็นจริง)
 */
export function parseProcStat(content: string): CpuSnapshot | null {
  let snapshot: CpuSnapshot | null = null;
  let count = 0;

  for (const line of content.split("\n")) {
    if (line.startsWith("cpu ")) {
      const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
      if (fields.length < 4 || fields.some((n) => !Number.isFinite(n))) return null;
      const total = fields.reduce((a, b) => a + b, 0);
      const idle = (fields[3] ?? 0) + (fields[4] ?? 0); // idle + iowait
      snapshot = { total, idle, count: 0 };
    } else if (/^cpu\d+\s/.test(line)) {
      count++;
    }
  }

  if (!snapshot) return null;
  // เครื่อง 1 core บาง kernel ไม่มีบรรทัด cpu0 แยก — ต่ำสุดต้องเป็น 1 ไม่งั้น CHECK ใน DB จะ reject
  snapshot.count = Math.max(1, count);
  return snapshot;
}

/**
 * CPU% จาก delta ของสองตัวอย่าง — 0-100 ต่อทั้งเครื่อง (รวมทุก core แล้ว)
 *
 * total ไม่เพิ่ม (delta <= 0) เกิดได้จริงเมื่อเวลาห่างกันน้อยมากหรือ counter reset หลัง host reboot
 * — คืน null ให้ข้ามรอบนั้นแทนที่จะรายงาน 0% ซึ่งอ่านเหมือน "เครื่องว่าง" ทั้งที่ไม่รู้ค่าจริง
 */
export function cpuPercentFromDelta(prev: CpuSnapshot, curr: CpuSnapshot): number | null {
  const totalDelta = curr.total - prev.total;
  const idleDelta = curr.idle - prev.idle;
  if (totalDelta <= 0) return null;
  const busy = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.min(100, Math.max(0, busy));
}

/** MemTotal/MemAvailable จาก /proc/meminfo (หน่วยในไฟล์เป็น kB = 1024 bytes) */
export function parseMemInfo(content: string): { totalBytes: number; usedBytes: number } | null {
  let total: number | null = null;
  let available: number | null = null;

  for (const line of content.split("\n")) {
    const match = /^(MemTotal|MemAvailable):\s+(\d+)\s+kB/.exec(line);
    if (!match) continue;
    const value = Number(match[2]) * 1024;
    if (match[1] === "MemTotal") total = value;
    else available = value;
  }

  if (total === null || total <= 0) return null;
  // MemAvailable มีตั้งแต่ kernel 3.14 — เครื่องเก่ากว่านั้นถือว่าอ่านไม่ได้ (ดีกว่าเดาจาก MemFree
  // ซึ่งไม่รวม cache/buffer ที่ระบบคืนได้ แล้วรายงาน "เต็ม" ทั้งที่ยังว่าง)
  if (available === null) return null;
  return { totalBytes: total, usedBytes: Math.max(0, total - available) };
}

/** "0.15 0.20 0.18 1/234 5678" → [1min, 5min, 15min] */
export function parseLoadAvg(content: string): [number, number, number] | null {
  const parts = content.trim().split(/\s+/);
  const values = parts.slice(0, 3).map(Number);
  if (values.length < 3 || values.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return [values[0] as number, values[1] as number, values[2] as number];
}

/**
 * แยกผลลัพธ์ `df -Pk <path>` — -P บังคับหนึ่งบรรทัดต่อ filesystem (ไม่ตัดบรรทัดเมื่อชื่อ device ยาว)
 * และ -k บังคับหน่วย 1024 bytes ชัดเจน (ถ้าใช้ -P เดี่ยว ๆ POSIX ระบุ 512 bytes แต่ GNU ใช้ 1024
 * — ต่างกันเท่าตัวและไม่มีอะไรในผลลัพธ์บอกว่าใช้อันไหน)
 *
 *   Filesystem     1024-blocks     Used Available Capacity Mounted on
 *   /dev/sda1         51475068  7812500  41049444      17% /data
 */
export function parseDf(stdout: string): { totalBytes: number; usedBytes: number } | null {
  const lines = stdout.trim().split("\n");
  if (lines.length < 2) return null;

  // บรรทัดสุดท้ายเสมอ — ถ้ามีหลาย filesystem (ไม่ควรเกิดเพราะส่ง path เดียว) เอาอันท้ายสุด
  const fields = (lines[lines.length - 1] as string).trim().split(/\s+/);
  if (fields.length < 4) return null;

  const totalKb = Number(fields[1]);
  const usedKb = Number(fields[2]);
  if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb) || totalKb <= 0) return null;

  return { totalBytes: totalKb * 1024, usedBytes: Math.max(0, usedKb) * 1024 };
}

async function readDiskUsage(
  path: string,
): Promise<{ totalBytes: number; usedBytes: number } | null> {
  try {
    const proc = Bun.spawn(["df", "-Pk", path], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    if (code !== 0) return null;
    return parseDf(stdout);
  } catch {
    return null;
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * ตัวเก็บ host metrics — มี state (ตัวอย่าง CPU ก่อนหน้า) จึงเป็น class ไม่ใช่ฟังก์ชันล้วน
 *
 * เรียก sample() ครั้งแรกจะคืน null เสมอเพราะยังไม่มีค่าเทียบสำหรับคำนวณ CPU%
 * (ผู้เรียกไม่ต้องทำอะไรพิเศษ — รอบถัดไปได้ค่าปกติ)
 */
export class HostMetricsReader {
  private prevCpu: CpuSnapshot | null = null;

  constructor(private readonly diskPath: string) {}

  async sample(now = Date.now()): Promise<HostSample | null> {
    const [statRaw, memRaw, loadRaw, disk] = await Promise.all([
      readTextFile("/proc/stat"),
      readTextFile("/proc/meminfo"),
      readTextFile("/proc/loadavg"),
      readDiskUsage(this.diskPath),
    ]);

    const cpuNow = statRaw ? parseProcStat(statRaw) : null;
    const prev = this.prevCpu;
    if (cpuNow) this.prevCpu = cpuNow;

    // ต้องมีครบทุกส่วนถึงจะเก็บได้ — เก็บบางส่วนแล้วใส่ 0 ที่เหลือทำให้กราฟโกหก
    if (!cpuNow || !prev || !memRaw || !loadRaw || !disk) return null;

    const cpuPercent = cpuPercentFromDelta(prev, cpuNow);
    const mem = parseMemInfo(memRaw);
    const load = parseLoadAvg(loadRaw);
    if (cpuPercent === null || !mem || !load) return null;

    return {
      ts: now,
      cpuPercent,
      cpuCount: cpuNow.count,
      memUsedBytes: mem.usedBytes,
      memTotalBytes: mem.totalBytes,
      diskUsedBytes: disk.usedBytes,
      diskTotalBytes: disk.totalBytes,
      load1: load[0],
      load5: load[1],
      load15: load[2],
    };
  }
}
