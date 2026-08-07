/**
 * Docker prune operations — Phase 11
 *
 * BuildKit cache โตไม่จำกัดตามจำนวน build — บนเครื่องเล็กเป็นสาเหตุอันดับหนึ่งที่ดิสก์เต็ม
 * แล้ว deploy ถัดไปพังด้วย DISK_FULL
 *
 * ความปลอดภัย: ทุกคำสั่งเป็น prune ของ Docker เอง ซึ่ง**ไม่แตะ resource ที่ยังถูกใช้อยู่**
 * - buildx prune  → ลบเฉพาะ cache layer ไม่แตะ image/container
 * - image prune   → ลบเฉพาะ dangling (ไม่มี tag และไม่มี container อ้างถึง)
 * ไม่ใช้ `-a` เด็ดขาด: `image prune -a` จะลบ image ของ deployment เก่าที่ rollback ต้องใช้
 * และ image ของ database ที่ container หยุดอยู่ชั่วคราว
 */

import { MAINTENANCE } from "@zixploy/shared";

export interface PruneResult {
  reclaimedBytes: number;
  summary: string;
}

/**
 * ดึงตัวเลข "Total reclaimed space" จากท้ายผลลัพธ์ของ docker prune
 *
 * รูปแบบ: "Total reclaimed space: 1.234GB" — หน่วยเป็นฐาน 1000 (docker ใช้ HumanSize)
 * ไม่มีบรรทัดนี้ = ไม่มีอะไรถูกลบ → 0
 */
export function parseReclaimed(stdout: string): number {
  const match = /Total reclaimed space:\s*([\d.]+)\s*([A-Za-z]*)/i.exec(stdout);
  if (!match) return 0;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;

  const units: Record<string, number> = {
    b: 1,
    kb: 1000,
    mb: 1000 ** 2,
    gb: 1000 ** 3,
    tb: 1000 ** 4,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  };
  const unit = (match[2] ?? "b").toLowerCase();
  return Math.round(value * (units[unit] ?? 1));
}

async function dockerExec(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; out: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const proc = Bun.spawn(["docker", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    const code = await proc.exited;
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, out: `${stdout}\n${stderr}` };
  } finally {
    clearTimeout(timer);
  }
}

function humanBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/**
 * ล้าง BuildKit cache ที่เก่ากว่า keepCacheHours
 *
 * ไม่ล้างทั้งหมดโดย default เพราะ build ถัดไปจะช้ามากถ้าไม่มี cache เลย
 * (`--filter until=` รับหน่วยชั่วโมงในรูป "168h")
 */
export async function pruneBuildCache(): Promise<PruneResult> {
  const { code, out } = await dockerExec(
    ["buildx", "prune", "-f", "--filter", `until=${MAINTENANCE.keepCacheHours}h`],
    MAINTENANCE.jobTimeoutMs,
  );
  if (code !== 0) throw new Error(`buildx prune ล้มเหลว: ${out.trim().slice(0, 300)}`);

  const reclaimed = parseReclaimed(out);
  return { reclaimedBytes: reclaimed, summary: `build cache ${humanBytes(reclaimed)}` };
}

/**
 * ลบ dangling image (ไม่มี tag และไม่มี container อ้างถึง)
 *
 * ไม่ใช้ -a: image ที่มี tag คือ image ของ deployment เก่าที่ rollback ต้องใช้
 * (cleanup ตาม retention policy จัดการแยกอยู่แล้วใน pipeline/cleanup.ts)
 */
export async function pruneDanglingImages(): Promise<PruneResult> {
  const { code, out } = await dockerExec(["image", "prune", "-f"], MAINTENANCE.jobTimeoutMs);
  if (code !== 0) throw new Error(`image prune ล้มเหลว: ${out.trim().slice(0, 300)}`);

  const reclaimed = parseReclaimed(out);
  return { reclaimedBytes: reclaimed, summary: `image ที่ไม่ใช้ ${humanBytes(reclaimed)}` };
}

export async function runPrune(
  type: "prune_build_cache" | "prune_images" | "prune_all",
): Promise<PruneResult> {
  if (type === "prune_build_cache") return pruneBuildCache();
  if (type === "prune_images") return pruneDanglingImages();

  const cache = await pruneBuildCache();
  const images = await pruneDanglingImages();
  const total = cache.reclaimedBytes + images.reclaimedBytes;
  return {
    reclaimedBytes: total,
    summary: `${cache.summary}, ${images.summary} (รวม ${humanBytes(total)})`,
  };
}
