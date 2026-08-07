/**
 * Self-update — Phase 12
 *
 * ## ปัญหาที่ต้องแก้
 *
 * ตัว update ต้อง `docker compose pull && up -d` ซึ่งจะ **recreate ทั้ง control-api,
 * dashboard และ worker เอง** — worker ที่รันคำสั่งอยู่จะถูกฆ่ากลางทาง คำสั่งตายก่อนจบ
 * งานค้างในสถานะ leased ตลอดไป และไม่มีใครรู้ว่าอัปเดตสำเร็จหรือไม่
 *
 * ## ทางออก: updater container แบบ one-shot ที่อยู่นอก stack
 *
 * worker แค่ **สั่งเกิด** container ตัวใหม่แล้วจบหน้าที่ตัวเอง — container นั้นไม่ได้เป็น
 * service ใน compose จึงไม่อยู่ในขอบเขตของ `up -d` และไม่ถูก recreate มันทำงานต่อจนจบ
 * แม้ worker/api จะถูกเปลี่ยนใหม่ระหว่างนั้น (หลักการเดียวกับที่ Watchtower ใช้อัปเดตตัวเอง)
 *
 * worker จึง mark งานเป็น done ทันทีที่ spawn สำเร็จ — ไม่ใช่ "อัปเดตเสร็จแล้ว" แต่หมายถึง
 * "ส่งมอบงานให้ updater เรียบร้อย" ผลลัพธ์จริงดูจากเวอร์ชันที่ขึ้นหลังระบบกลับมา
 */

import { AppError, REGISTRY_NAMESPACE, SERVICE_IMAGES } from "@zixploy/shared";

/** path บน host ที่ install.sh วางไฟล์ไว้ — updater ต้อง mount เข้าไปเพื่อรัน compose */
const INSTALL_DIR = process.env.ZIXPLOY_INSTALL_DIR ?? "/opt/zixploy";

/**
 * image ที่ใช้รัน updater — ต้องมี docker CLI + compose plugin
 * ใช้ image ทางการของ Docker เพื่อไม่ต้อง build/เผยแพร่ image เพิ่มเอง
 */
const UPDATER_IMAGE = "docker:28-cli";

async function docker(args: string[], timeoutMs = 60_000): Promise<{ code: number; out: string }> {
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
    return { code, out: `${stdout}\n${stderr}`.trim() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * สคริปต์ที่ updater รันข้างใน
 *
 * เขียน ZIXPLOY_VERSION ลง .env ก่อน แล้วค่อย pull/up — compose อ่านเวอร์ชันจากไฟล์นี้
 * ทำให้รีสตาร์ทครั้งถัดไป (หรือ reboot เครื่อง) ยังได้เวอร์ชันเดิม ไม่ย้อนกลับ
 *
 * `|| true` ที่ prune ท้ายสุด: ลบ image เก่าไม่สำเร็จไม่ควรทำให้ทั้งการอัปเดตนับเป็นล้มเหลว
 * ทั้งที่ container ใหม่ขึ้นเรียบร้อยแล้ว
 */
function updateScript(version: string): string {
  return [
    "set -e",
    `cd ${INSTALL_DIR}`,
    // เขียนทับบรรทัด ZIXPLOY_VERSION เดิม (ถ้ามี) แล้วเติมของใหม่
    `sed -i '/^ZIXPLOY_VERSION=/d' .env 2>/dev/null || true`,
    `echo "ZIXPLOY_VERSION=${version}" >> .env`,
    "docker compose pull",
    "docker compose up -d --remove-orphans",
    "docker image prune -f || true",
  ].join("\n");
}

/** ตรวจว่า tag ที่ขอมีอยู่จริงทุก image ก่อนลงมือ — pull ไม่เจอกลางทางแล้วค้างครึ่ง ๆ กลาง ๆ */
async function assertImagesExist(version: string): Promise<void> {
  for (const service of SERVICE_IMAGES) {
    const ref = `${REGISTRY_NAMESPACE}-${service}:${version}`;
    const { code, out } = await docker(["manifest", "inspect", ref], 30_000);
    if (code !== 0) {
      throw new AppError(
        "MAINTENANCE_FAILED",
        `ไม่พบ image ${ref} บน registry — ยกเลิกการอัปเดต (${out.slice(0, 200)})`,
      );
    }
  }
}

export interface SelfUpdateResult {
  summary: string;
}

/**
 * สั่ง updater ให้เริ่มทำงานแล้วคืนทันที
 *
 * `-d` (detach) + `--rm` — worker ไม่รอผล เพราะถ้ารอ worker จะถูกฆ่าก่อน updater ทำเสร็จ
 * และ `docker run` ที่ค้างอยู่จะไม่มีวันคืนค่า
 */
export async function startSelfUpdate(version: string): Promise<SelfUpdateResult> {
  await assertImagesExist(version);

  const { code, out } = await docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    // ชื่อคงที่ — ถ้ามีตัวเดิมค้างอยู่ docker จะปฏิเสธ กันสั่งอัปเดตซ้อนกันอีกชั้น
    "zixploy-updater",
    "--network",
    "none",
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
    "-v",
    `${INSTALL_DIR}:${INSTALL_DIR}`,
    "-w",
    INSTALL_DIR,
    UPDATER_IMAGE,
    "sh",
    "-c",
    updateScript(version),
  ]);

  if (code !== 0) {
    throw new AppError("MAINTENANCE_FAILED", `เริ่ม updater ไม่สำเร็จ: ${out.slice(0, 300)}`);
  }

  return {
    summary: `เริ่มอัปเดตเป็น ${version} แล้ว — ระบบจะรีสตาร์ทเองในไม่กี่นาที`,
  };
}
