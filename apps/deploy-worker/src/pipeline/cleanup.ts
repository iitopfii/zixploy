/**
 * Image retention cleanup — เก็บ image ของ N deployment ที่ succeeded ล่าสุดต่อ project (default 3
 * — IMAGE_RETENTION_KEEP_COUNT ใน @zixploy/shared), ลบที่เก่ากว่า เรียกแบบ inline ท้าย build.ts
 * ทุกครั้งที่ deployment ถึง succeeded (build หรือ rollback ก็ตาม) — ไม่ใช่ queued job แยก
 * (deploy_jobs.type='cleanup' เผื่อไว้ใน schema ตั้งแต่ M1 แต่ยังไม่มี control-api route ใดสั่งงาน
 * ประเภทนี้จริง — ตัดสินใจให้ cleanup เป็นส่วนหนึ่งของ deploy job เดิมแทน เพราะ ADR-0002 ห้าม worker
 * insert job ใหม่เอง และ M7's scope ไม่ได้รวมการแก้ control-api)
 *
 * สำคัญ — ไม่ sweep ตาม deployments.image_tag ใน DB อย่างเดียว: buildkit.ts's docstring บันทึกไว้ว่า
 * BuildKit อาจ tag image สำเร็จฝั่ง server หลัง client cancel ไปแล้ว (image ไม่เคยถูกบันทึกใน DB
 * เพราะ pipeline fail ก่อนถึง step ที่เขียน image_tag) cleanup จึงสวีปจาก docker images ตาม
 * ownership label โดยตรง (ADR-0005) แล้วเทียบกับ "keep set" จาก DB แทนที่จะวนตาม DB อย่างเดียว
 *
 * Safety (ADR-0005 ตัวอักษร): ทุก destructive call ต้อง re-verify platform.project_id label
 * ตรงกับ project ที่ cleanup ถูกสโคปไว้ก่อนลบเสมอ — ไม่เชื่อผล `docker images --filter` เพียงอย่าง
 * เดียว (เผื่อ label หลุด/race) เรียก inspectImage ซ้ำอีกชั้นก่อนลบจริงทุกครั้ง
 */

import type { Database } from "bun:sqlite";
import { IMAGE_RETENTION_KEEP_COUNT, LABELS } from "@zixploy/shared";
import type { DockerCliClient } from "../docker/cli-client";

export interface CleanupParams {
  db: Database;
  docker: DockerCliClient;
  projectId: string;
  keepCount?: number;
  onLog: (line: string) => void;
}

export interface CleanupResult {
  removed: string[];
  skipped: string[];
}

interface KeepRow {
  image_tag: string | null;
}

/** image_tag ของ deployment ที่ succeeded ล่าสุด N รายการของ project — ต้องเก็บไว้เสมอ ไม่ลบ */
function loadKeepSet(db: Database, projectId: string, keepCount: number): Set<string> {
  const rows = db
    .query<KeepRow, [string, number]>(
      "SELECT image_tag FROM deployments WHERE project_id = ? AND status = 'succeeded' AND image_tag IS NOT NULL ORDER BY finished_at DESC LIMIT ?",
    )
    .all(projectId, keepCount);
  return new Set(rows.map((r) => r.image_tag).filter((tag): tag is string => tag != null));
}

/**
 * ลบ image เก่าของ project ที่ไม่อยู่ใน keep set และไม่มี container ไหนอ้างอิงอยู่จริง
 * best-effort เสมอ — image เดียวลบไม่สำเร็จ (เช่น race กับ container ที่เพิ่งสร้าง) ไม่ทำให้ทั้ง
 * cleanup ล้มเหลว แค่ skip แล้ว log ต่อ ผู้เรียก (build.ts) ต้องไม่ให้ cleanup error กระทบผล deploy
 */
export async function cleanupProjectImages(params: CleanupParams): Promise<CleanupResult> {
  const { db, docker, projectId, keepCount = IMAGE_RETENTION_KEEP_COUNT, onLog } = params;

  const keepTags = loadKeepSet(db, projectId, keepCount);

  // double-check นอกเหนือจาก DB: container ไหนก็ตาม (running หรือ stopped ที่ยังไม่ถูกลบ) ของ
  // project นี้อ้างอิง image ไหนอยู่ — ห้ามลบ image นั้นไม่ว่า DB จะว่าอย่างไร
  const liveContainers = await docker.listContainersByLabel({ [LABELS.projectId]: projectId });
  const liveImageRefs = new Set(liveContainers.map((c) => c.Image));

  const images = await docker.listImagesByLabel({
    [LABELS.managed]: "true",
    [LABELS.projectId]: projectId,
  });

  const removed: string[] = [];
  const skipped: string[] = [];

  for (const img of images) {
    const ref = `${img.Repository}:${img.Tag}`;

    if (keepTags.has(ref)) {
      skipped.push(ref);
      continue;
    }
    if (liveImageRefs.has(ref) || liveImageRefs.has(img.ID)) {
      skipped.push(ref);
      continue;
    }

    // re-verify ownership label บน resource จริงก่อนลบเสมอ (ADR-0005) — ไม่เชื่อผล list ด้านบนเพียงอย่างเดียว
    const info = await docker.inspectImage(ref);
    if (!info) {
      // ถูกลบไปแล้วโดยรอบ cleanup อื่น/มือ — ไม่ใช่ error
      continue;
    }
    const labelProjectId = info.Config.Labels?.[LABELS.projectId];
    if (labelProjectId !== projectId) {
      onLog(
        `ข้าม image ${ref} — platform.project_id ไม่ตรงตอน re-verify (${labelProjectId ?? "ไม่มี"} ≠ ${projectId})`,
      );
      skipped.push(ref);
      continue;
    }

    try {
      // ไม่ force — ถ้ามี container อ้างอิงอยู่จริง (race กับ double-check ด้านบน) ให้ docker ปฏิเสธ
      // เองแทนลบทับ container ที่กำลังใช้ image นั้นอยู่
      await docker.removeImage(ref, { force: false });
      removed.push(ref);
      onLog(`ลบ image เก่า: ${ref}`);
    } catch (err) {
      skipped.push(ref);
      onLog(
        `ลบ image ${ref} ไม่สำเร็จ (ข้ามไปก่อน): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { removed, skipped };
}
