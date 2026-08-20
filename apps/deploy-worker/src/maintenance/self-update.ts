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

import { AppError, composeFileUrl, REGISTRY_NAMESPACE, SERVICE_IMAGES } from "@zixploy/shared";

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
 * ## ทำไมต้องอัปเดต compose file ด้วย
 *
 * เดิม updater แค่ `pull` + `up -d` โดยใช้ docker-compose.yml ไฟล์เดิมที่ install.sh วางไว้
 * ตอนติดตั้งครั้งแรก — การแก้ compose ใด ๆ ในรุ่นถัดมา (service ใหม่, env var เพิ่ม, label
 * เปลี่ยน) จึงไปไม่ถึงเครื่องที่อัปเดตผ่านปุ่ม มีแต่คนติดตั้งใหม่เท่านั้นที่ได้ และไม่มีอะไร
 * เตือนเลยว่าไฟล์ล้าสมัย (พบตอนเพิ่ม ZIXPLOY_INSTALL_DIR ให้ control-api ในรุ่น 0.1.15)
 *
 * ## หลักความปลอดภัยของขั้นตอนนี้
 *
 * compose file คือสิ่งเดียวที่บอกว่าระบบประกอบด้วยอะไร — ไฟล์พังเท่ากับทั้งเครื่องขึ้นไม่ได้
 * จึงยึดสามข้อ:
 *  1. **ปักหมุดตาม tag ของเวอร์ชันเป้าหมาย** ไม่ใช่ main (main อาจล้ำหน้าไปหลายรุ่น)
 *  2. **fail-soft ตอนโหลด** — โหลดไม่ได้/ไฟล์ว่าง ให้ใช้ไฟล์เดิมต่อ ดีกว่าอัปเดตไม่สำเร็จทั้งรุ่น
 *     (พฤติกรรมเท่าเดิมพอดี ไม่ได้แย่ลง)
 *  3. **ตรวจก่อนใช้ + ย้อนกลับได้เสมอ** — `docker compose config` ต้องผ่านก่อน ถ้า `up -d`
 *     ล้มเหลวให้คืนไฟล์เดิมแล้ว up ใหม่ทันที ระบบจึงไม่มีทางค้างอยู่กับ compose ที่ใช้ไม่ได้
 *
 * ไม่ย้อน ZIXPLOY_VERSION ตอน rollback โดยตั้งใจ — image ใหม่ถูก pull มาแล้วและอาจรัน migration
 * ไปแล้ว การถอย schema กลับอันตรายกว่าการรัน image ใหม่ด้วย compose เดิม (ซึ่งคือพฤติกรรมเดิม
 * ของ updater อยู่แล้ว จึงรู้ว่าใช้งานได้)
 *
 * **worker เป็นคนโหลดไฟล์ ไม่ใช่ updater** — updater รันด้วย `--network none` โดยตั้งใจเพราะมัน
 * mount docker.sock (ยึด container นี้ได้ = ยึดเครื่องได้) การเปิดเน็ตให้มันเพื่อโหลดไฟล์เดียว
 * ไม่คุ้มความเสี่ยง จึงส่งเนื้อหาเข้าไปทาง env var แทน
 *
 * `|| true` ที่ prune ท้ายสุด: ลบ image เก่าไม่สำเร็จไม่ควรทำให้ทั้งการอัปเดตนับเป็นล้มเหลว
 * ทั้งที่ container ใหม่ขึ้นเรียบร้อยแล้ว
 */
export function updateScript(version: string, hasNewCompose: boolean): string {
  const lines = [
    "set -e",
    `cd ${INSTALL_DIR}`,
    // เขียนทับบรรทัด ZIXPLOY_VERSION เดิม (ถ้ามี) แล้วเติมของใหม่ — ต้องทำก่อนตรวจ compose
    // เพราะ `docker compose config` ต้อง interpolate ${ZIXPLOY_VERSION} ได้
    `sed -i '/^ZIXPLOY_VERSION=/d' .env 2>/dev/null || true`,
    `echo "ZIXPLOY_VERSION=${version}" >> .env`,
    "",
    "COMPOSE_SWAPPED=0",
  ];

  if (hasNewCompose) {
    lines.push(
      "# --- compose ของเวอร์ชันเป้าหมาย (worker โหลดมาให้ทาง env) ---",
      // printf '%s' ไม่ใช่ echo — echo ตีความ backslash/-n ในบางเชลล์ ทำให้ YAML เพี้ยน
      'printf %s "$ZIXPLOY_NEW_COMPOSE" > docker-compose.yml.new',
      "if [ -s docker-compose.yml.new ]; then",
      "  cp docker-compose.yml docker-compose.yml.bak",
      "  mv docker-compose.yml.new docker-compose.yml",
      "  if docker compose config >/dev/null 2>&1; then",
      "    COMPOSE_SWAPPED=1",
      '    echo "อัปเดต docker-compose.yml เป็นของรุ่นนี้แล้ว"',
      "  else",
      "    mv docker-compose.yml.bak docker-compose.yml",
      '    echo "compose ของรุ่นใหม่ตรวจไม่ผ่าน — ใช้ไฟล์เดิมต่อ"',
      "  fi",
      "else",
      "  rm -f docker-compose.yml.new",
      "fi",
      "",
    );
  }

  lines.push(
    "# คืน compose เดิมแล้วพยุงระบบกลับขึ้นมา — ใช้เมื่อ pull/up ด้วยไฟล์ใหม่ล้มเหลว",
    "restore_compose() {",
    '  if [ "$COMPOSE_SWAPPED" = "1" ] && [ -f docker-compose.yml.bak ]; then',
    "    mv docker-compose.yml.bak docker-compose.yml",
    '    echo "คืน docker-compose.yml เดิมแล้ว กำลัง start ระบบกลับ"',
    "    docker compose up -d --remove-orphans || true",
    "  fi",
    "}",
    "",
    "docker compose pull || { restore_compose; exit 1; }",
    "docker compose up -d --remove-orphans || { restore_compose; exit 1; }",
    "",
    "rm -f docker-compose.yml.bak",
    "docker image prune -f || true",
  );

  return lines.join("\n");
}

/**
 * โหลด compose file ของเวอร์ชันเป้าหมายจาก repo — คืน null เมื่อโหลดไม่ได้หรือเนื้อหาไม่น่าเชื่อถือ
 *
 * fail-soft ทุกกรณี: คืน null = updater ใช้ compose เดิมต่อ (พฤติกรรมเดิมก่อนมีฟีเจอร์นี้)
 * ดีกว่ายกเลิกการอัปเดตทั้งรุ่นเพราะโหลดไฟล์เสริมไม่ได้
 *
 * ตรวจเนื้อหาคร่าว ๆ ก่อนส่งต่อ — กันเคสที่ CDN/proxy ตอบหน้า HTML error มาด้วย HTTP 200
 * (การตรวจจริงจังคือ `docker compose config` ในตัว updater ซึ่งเห็น .env ของเครื่องนั้นด้วย)
 */
export async function fetchComposeFile(version: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(composeFileUrl(version), { signal: controller.signal });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.includes("services:")) return null;
    // ต้องมีครบทุก service ที่ระบบต้องใช้ — ไฟล์ที่ขาดตัวใดตัวหนึ่งแปลว่าไม่ใช่ compose ของเรา
    if (!SERVICE_IMAGES.every((svc) => text.includes(svc))) return null;
    return text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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

  // โหลดตรงนี้เพราะ worker มีเน็ต ส่วน updater ตั้งใจรันแบบ --network none (มี docker.sock)
  // null = ใช้ compose เดิมต่อ ไม่ยกเลิกการอัปเดต
  const newCompose = await fetchComposeFile(version);

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
    // ส่งเนื้อหา compose ทาง env — ไม่ฝังในสคริปต์เพื่อไม่ต้องกังวลเรื่อง quoting ของ YAML
    ...(newCompose ? ["-e", `ZIXPLOY_NEW_COMPOSE=${newCompose}`] : []),
    UPDATER_IMAGE,
    "sh",
    "-c",
    updateScript(version, newCompose != null),
  ]);

  if (code !== 0) {
    throw new AppError("MAINTENANCE_FAILED", `เริ่ม updater ไม่สำเร็จ: ${out.slice(0, 300)}`);
  }

  return {
    summary: `เริ่มอัปเดตเป็น ${version} แล้ว — ระบบจะรีสตาร์ทเองในไม่กี่นาที`,
  };
}
