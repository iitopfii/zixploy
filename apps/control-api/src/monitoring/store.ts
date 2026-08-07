/**
 * อ่าน metrics time-series — Phase 9 M3
 *
 * control-api อ่านอย่างเดียว ไม่เคยเขียนสองตารางนี้ (worker เป็นผู้เขียนผู้เดียว ตาม ADR-0002)
 * ไม่มีการเรียก Docker หรืออ่าน /proc ที่นี่ — ข้อมูลทุกอย่างมาจาก SQLite
 */

import type { Database } from "bun:sqlite";
import { MONITORING } from "@zixploy/shared";

export interface HostPoint {
  ts: number;
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  load1: number;
  load5: number;
  load15: number;
  cpuCount: number;
}

export interface ContainerPoint {
  ts: number;
  cpuPercent: number;
  memUsedBytes: number;
  memLimitBytes: number;
  restartCount: number;
  running: boolean;
}

interface HostRow {
  ts: number;
  cpu_percent: number;
  mem_used_bytes: number;
  mem_total_bytes: number;
  disk_used_bytes: number;
  disk_total_bytes: number;
  load1: number;
  load5: number;
  load15: number;
  cpu_count: number;
}

interface ContainerRow {
  ts: number;
  cpu_percent: number;
  mem_used_bytes: number;
  mem_limit_bytes: number;
  restart_count: number;
  running: number;
}

/**
 * ลดจำนวนจุดให้ไม่เกิน maxPoints โดย **เก็บยอดแหลมไว้**
 *
 * แบ่งเป็น bucket เท่า ๆ กันแล้วเลือกจุดที่ cpuPercent สูงสุดของแต่ละ bucket — ไม่ใช้ค่าเฉลี่ย
 * เพราะ spike สั้น ๆ (ซึ่งเป็นสิ่งที่คนเปิดกราฟ monitoring มาหา) จะถูกเฉลี่ยจนหายไป
 * และไม่หยิบทุก ๆ N จุดเพราะ spike ที่ไม่ตรงจังหวะ stride จะหายเช่นกัน
 *
 * ผลลัพธ์ยังเรียงตามเวลาเสมอ (bucket เรียงอยู่แล้ว และในแต่ละ bucket เลือกมาแค่จุดเดียว)
 */
export function downsampleByPeak<T extends { ts: number; cpuPercent: number }>(
  points: T[],
  maxPoints: number,
): T[] {
  if (points.length <= maxPoints || maxPoints <= 0) return points;

  const bucketSize = Math.ceil(points.length / maxPoints);
  const out: T[] = [];

  for (let i = 0; i < points.length; i += bucketSize) {
    let peak = points[i] as T;
    for (let j = i + 1; j < i + bucketSize && j < points.length; j++) {
      const candidate = points[j] as T;
      if (candidate.cpuPercent > peak.cpuPercent) peak = candidate;
    }
    out.push(peak);
  }

  return out;
}

/** clamp ช่วงเวลาที่ขอไม่ให้เกิน retention จริง — กัน query ที่ scan ทั้งตาราง */
export function resolveRange(rangeMs: number | undefined, now = Date.now()) {
  const span = Math.min(
    Math.max(rangeMs ?? 60 * 60 * 1000, MONITORING.sampleIntervalMs),
    MONITORING.maxRangeMs,
  );
  return { fromTs: now - span, toTs: now, spanMs: span };
}

export function listHostPoints(db: Database, fromTs: number): HostPoint[] {
  const rows = db
    .query<HostRow, [number]>(
      `SELECT ts, cpu_percent, mem_used_bytes, mem_total_bytes,
              disk_used_bytes, disk_total_bytes, load1, load5, load15, cpu_count
       FROM host_metrics
       WHERE ts >= ?
       ORDER BY ts`,
    )
    .all(fromTs);

  return rows.map((r) => ({
    ts: r.ts,
    cpuPercent: r.cpu_percent,
    memUsedBytes: r.mem_used_bytes,
    memTotalBytes: r.mem_total_bytes,
    diskUsedBytes: r.disk_used_bytes,
    diskTotalBytes: r.disk_total_bytes,
    load1: r.load1,
    load5: r.load5,
    load15: r.load15,
    cpuCount: r.cpu_count,
  }));
}

/**
 * ตัวอย่างล่าสุดของ host — แยก query จาก listHostPoints เพราะ "ค่าปัจจุบัน" ต้องแสดงได้เสมอ
 * แม้ผู้ใช้เลือกช่วงเวลาที่ยังไม่มีข้อมูล (เช่นเพิ่งรีสตาร์ท worker แล้วขอกราฟ 1 ชม.)
 */
export function latestHostPoint(db: Database): HostPoint | null {
  const row = db
    .query<HostRow, []>(
      `SELECT ts, cpu_percent, mem_used_bytes, mem_total_bytes,
              disk_used_bytes, disk_total_bytes, load1, load5, load15, cpu_count
       FROM host_metrics ORDER BY ts DESC LIMIT 1`,
    )
    .get();
  if (!row) return null;

  return {
    ts: row.ts,
    cpuPercent: row.cpu_percent,
    memUsedBytes: row.mem_used_bytes,
    memTotalBytes: row.mem_total_bytes,
    diskUsedBytes: row.disk_used_bytes,
    diskTotalBytes: row.disk_total_bytes,
    load1: row.load1,
    load5: row.load5,
    load15: row.load15,
    cpuCount: row.cpu_count,
  };
}

export function listContainerPoints(
  db: Database,
  projectId: string,
  fromTs: number,
): ContainerPoint[] {
  const rows = db
    .query<ContainerRow, [string, number]>(
      `SELECT ts, cpu_percent, mem_used_bytes, mem_limit_bytes, restart_count, running
       FROM container_metrics
       WHERE project_id = ? AND ts >= ?
       ORDER BY ts`,
    )
    .all(projectId, fromTs);

  return rows.map((r) => ({
    ts: r.ts,
    cpuPercent: r.cpu_percent,
    memUsedBytes: r.mem_used_bytes,
    memLimitBytes: r.mem_limit_bytes,
    restartCount: r.restart_count,
    running: r.running === 1,
  }));
}

export function latestContainerPoint(db: Database, projectId: string): ContainerPoint | null {
  const row = db
    .query<ContainerRow, [string]>(
      `SELECT ts, cpu_percent, mem_used_bytes, mem_limit_bytes, restart_count, running
       FROM container_metrics WHERE project_id = ? ORDER BY ts DESC LIMIT 1`,
    )
    .get(projectId);
  if (!row) return null;

  return {
    ts: row.ts,
    cpuPercent: row.cpu_percent,
    memUsedBytes: row.mem_used_bytes,
    memLimitBytes: row.mem_limit_bytes,
    restartCount: row.restart_count,
    running: row.running === 1,
  };
}
