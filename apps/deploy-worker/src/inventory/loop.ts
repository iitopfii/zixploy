/**
 * Docker inventory loop — กวาดรายชื่อ container/image ทั้งเครื่องลง DB เป็นระยะ
 * ให้หน้า "Docker" ใน dashboard แสดงได้ (control-api อ่านตารางนี้อย่างเดียว — ADR-0002)
 *
 * ตาราง docker_containers/docker_images เป็น snapshot ล่าสุด ไม่ใช่ประวัติ: แต่ละรอบ
 * full-replace ในธุรกรรมเดียว (DELETE ทั้งหมด + INSERT ชุดใหม่) — container ที่หายไปจาก
 * Docker จึงหายจากตารางเองโดยไม่ต้อง prune
 *
 * fail-soft: docker มีปัญหา → คง snapshot เดิมไว้ (ไม่เคลียร์ทิ้ง) ดีกว่าหน้าเว็บวูบเป็นว่าง
 * ทั้งที่ container ยังรันอยู่จริง — รอบถัดไปค่อยอัปเดตทับ
 */

import type { Database } from "bun:sqlite";
import type { DockerCliClient } from "../docker/cli-client";

/** ความถี่กวาด — ถูกกว่า metrics (แค่ docker ps + docker images อย่างละครั้ง) แต่ไม่ต้องสดเท่า */
export const INVENTORY_INTERVAL_MS = 30_000;

/** container ของแพลตฟอร์มเอง — มี platform.* label หรือชื่อตาม convention ของระบบ */
function isManagedContainer(name: string, labels: string): boolean {
  if (labels.includes("platform.")) return true;
  return /^(zx-|zxsvc-|zixploy-)/.test(name);
}

/** image ที่แพลตฟอร์ม build/ใช้เอง — namespace "zixploy/" (imageName/componentImageName) */
function isManagedImage(repository: string): boolean {
  return repository === "zixploy" || repository.startsWith("zixploy/");
}

/**
 * กวาดหนึ่งรอบ: อ่านจาก Docker แล้ว full-replace ตาราง snapshot
 * คืน false เมื่อไม่ได้เขียนอะไร (docker ล้มทั้งสองรายการ — คง snapshot เดิม)
 */
export async function sweepDockerInventory(
  db: Database,
  docker: DockerCliClient,
  capturedAt = Date.now(),
): Promise<boolean> {
  const [containers, images] = await Promise.all([
    docker.listAllContainers(),
    docker.listAllImages(),
  ]);

  // ทั้งคู่ว่างพร้อมกันมักหมายถึง daemon ล่ม (เครื่องจริงมีอย่างน้อย control-plane เสมอ)
  // — ไม่เขียนทับ กัน snapshot วูบหายทั้งที่ระบบยังรัน (เครื่องว่างจริง ๆ จะเสียแค่ความสดรอบนี้)
  if (containers.length === 0 && images.length === 0) return false;

  const insertContainer = db.query(
    `INSERT INTO docker_containers
       (container_id, name, image, state, status, ports, networks, is_managed, created_text, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertImage = db.query(
    `INSERT INTO docker_images
       (image_id, repository, tag, size, created_since, is_managed, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    db.query("DELETE FROM docker_containers").run();
    for (const c of containers) {
      insertContainer.run(
        c.ID,
        c.Names,
        c.Image,
        c.State,
        c.Status,
        c.Ports || null,
        c.Networks || null,
        isManagedContainer(c.Names, c.Labels ?? "") ? 1 : 0,
        c.CreatedAt || null,
        capturedAt,
      );
    }
    db.query("DELETE FROM docker_images").run();
    for (const img of images) {
      insertImage.run(
        img.ID,
        img.Repository,
        img.Tag,
        img.Size || null,
        img.CreatedSince || null,
        isManagedImage(img.Repository) ? 1 : 0,
        capturedAt,
      );
    }
  })();

  return true;
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

/** loop หลัก — รูปแบบเดียวกับ metricsLoop: error รอบหนึ่งไม่หยุด loop */
export async function dockerInventoryLoop(
  db: Database,
  docker: DockerCliClient,
  signal: AbortSignal,
  onLog: (line: string) => void = () => {},
): Promise<void> {
  while (!signal.aborted) {
    try {
      await sweepDockerInventory(db, docker);
    } catch (err) {
      onLog(`เก็บ docker inventory ไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(INVENTORY_INTERVAL_MS, signal);
  }
}
