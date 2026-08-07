/**
 * เขียน metrics ลง DB + prune — Phase 9 (server monitoring)
 *
 * worker เป็นผู้เขียนตารางนี้เพียงผู้เดียว (ADR-0002) — control-api อ่านอย่างเดียว
 */

import type { Database } from "bun:sqlite";
import type { ContainerSample } from "./containers";
import type { HostSample } from "./host";

/**
 * INSERT OR REPLACE ไม่ใช่ INSERT ธรรมดา — ระหว่าง deploy worker ตัวใหม่อาจขึ้นก่อนตัวเก่าตาย
 * ทำให้สอง worker เก็บตัวอย่างในมิลลิวินาทีเดียวกันได้ ตัวหลังทับตัวแรกแทนที่จะ throw
 * (ข้อมูลรอบนั้นมาจากเครื่องเดียวกันอยู่แล้ว ค่าจึงเท่ากันในทางปฏิบัติ)
 */
export function insertHostSample(db: Database, sample: HostSample): void {
  db.query(
    `INSERT OR REPLACE INTO host_metrics
       (ts, cpu_percent, mem_used_bytes, mem_total_bytes,
        disk_used_bytes, disk_total_bytes, load1, load5, load15, cpu_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sample.ts,
    sample.cpuPercent,
    sample.memUsedBytes,
    sample.memTotalBytes,
    sample.diskUsedBytes,
    sample.diskTotalBytes,
    sample.load1,
    sample.load5,
    sample.load15,
    sample.cpuCount,
  );
}

/**
 * เขียนทุก sample ในธุรกรรมเดียว — รอบเก็บหนึ่งครั้งต้องขึ้นทั้งหมดหรือไม่ขึ้นเลย
 * ไม่งั้นกราฟของบาง project จะมีจุดที่ ts นั้นแต่บาง project ไม่มี ดูเหมือน container หายไป
 *
 * project ที่ถูกลบระหว่างรอบเก็บจะทำให้ FK ล้ม — ข้ามตัวนั้นแทนที่จะทิ้งทั้งธุรกรรม
 */
export function insertContainerSamples(db: Database, ts: number, samples: ContainerSample[]): void {
  if (samples.length === 0) return;

  const stmt = db.query(
    `INSERT OR REPLACE INTO container_metrics
       (ts, project_id, container_id, cpu_percent, mem_used_bytes, mem_limit_bytes, restart_count, running)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    for (const s of samples) {
      try {
        stmt.run(
          ts,
          s.projectId,
          s.containerId,
          s.cpuPercent,
          s.memUsedBytes,
          s.memLimitBytes,
          s.restartCount,
          s.running ? 1 : 0,
        );
      } catch {
        // FK ล้ม = project ถูกลบไปแล้ว — container ของมันจะถูก cleanup ตามมาเอง
      }
    }
  })();
}

/** ลบตัวอย่างที่เก่ากว่า cutoff ทั้งสองตาราง — คืนจำนวนแถวที่ลบรวม */
export function pruneMetrics(db: Database, cutoffTs: number): number {
  const host = db.query("DELETE FROM host_metrics WHERE ts < ?").run(cutoffTs);
  const container = db.query("DELETE FROM container_metrics WHERE ts < ?").run(cutoffTs);
  return (host.changes ?? 0) + (container.changes ?? 0);
}
