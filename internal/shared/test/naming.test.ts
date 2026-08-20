import { describe, expect, test } from "bun:test";
import { ulid } from "../src/id";
import {
  componentContainerName,
  componentImageName,
  componentLabels,
  componentVolumeName,
  containerName,
  deploymentLabels,
  deploymentNetworkName,
  imageName,
  projectSlug,
  volumeLabels,
  volumeName,
} from "../src/naming";

const projectId = ulid();
const deploymentId = ulid();
const componentId = ulid();
const volumeId = ulid();
const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

describe("naming", () => {
  test("image/container/volume names generate จาก IDs", () => {
    expect(imageName(projectId, sha, deploymentId)).toBe(
      `zixploy/${projectId.toLowerCase()}:a1b2c3d-${deploymentId.toLowerCase()}`,
    );
    expect(containerName(projectId, deploymentId)).toBe(
      `zx-${projectId.toLowerCase()}-${deploymentId.toLowerCase()}`,
    );
    expect(volumeName(projectId, volumeId)).toBe(
      `zxvol-${projectId.toLowerCase()}-${volumeId.toLowerCase()}`,
    );
  });

  test("ปฏิเสธ input ที่ไม่ใช่ ULID (กัน user input หลุดเข้ามา)", () => {
    expect(() => containerName("my-project!", deploymentId)).toThrow();
    expect(() => imageName(projectId, "not-a-sha", deploymentId)).toThrow();
    expect(() => volumeName(projectId, "data; rm -rf /")).toThrow();
  });

  test("รับ commitSha สังเคราะห์แบบ sha256 (64 hex) ของ dockerfile-paste source", () => {
    // Phase 13: source แบบวาง Dockerfile ใช้ sha256 ของเนื้อหาแทน git commit — ยาว 64 ตัว
    // regression: SHA_RE เดิมจำกัด 40 ตัว ทำให้ deploy แบบนี้ fail ทันทีก่อนเริ่ม build
    const sha256 = "f".repeat(64);
    expect(imageName(projectId, sha256, deploymentId)).toBe(
      `zixploy/${projectId.toLowerCase()}:fffffff-${deploymentId.toLowerCase()}`,
    );
    // เกิน 64 หรือมีอักขระนอก hex ยังต้องถูกปฏิเสธเหมือนเดิม
    expect(() => imageName(projectId, "f".repeat(65), deploymentId)).toThrow();
    expect(() => imageName(projectId, "F".repeat(64), deploymentId)).toThrow();
  });

  test("labels ครบตาม ownership convention", () => {
    expect(deploymentLabels(projectId, deploymentId)).toEqual({
      "platform.managed": "true",
      "platform.project_id": projectId,
      "platform.deployment_id": deploymentId,
    });
    expect(volumeLabels(projectId, volumeId)).toEqual({
      "platform.managed": "true",
      "platform.project_id": projectId,
      "platform.volume_id": volumeId,
    });
  });
});

describe("naming — multi-container (Phase 18)", () => {
  test("component container/image/network/volume names ผูก componentId", () => {
    expect(componentContainerName(projectId, deploymentId, componentId)).toBe(
      `zx-${projectId.toLowerCase()}-${deploymentId.toLowerCase()}-${componentId.toLowerCase()}`,
    );
    expect(componentImageName(projectId, componentId, sha, deploymentId)).toBe(
      `zixploy/${projectId.toLowerCase()}-${componentId.toLowerCase()}:a1b2c3d-${deploymentId.toLowerCase()}`,
    );
    expect(deploymentNetworkName(projectId, deploymentId)).toBe(
      `zx-dnet-${projectId.toLowerCase()}-${deploymentId.toLowerCase()}`,
    );
    expect(componentVolumeName(projectId, componentId, volumeId)).toBe(
      `zxvol-${projectId.toLowerCase()}-${componentId.toLowerCase()}-${volumeId.toLowerCase()}`,
    );
  });

  test("component names ต่างกันต่อ component — ไม่ชนกันในโปรเจกต์เดียว", () => {
    const c1 = ulid();
    const c2 = ulid();
    expect(componentContainerName(projectId, deploymentId, c1)).not.toBe(
      componentContainerName(projectId, deploymentId, c2),
    );
  });

  test("ปฏิเสธ input ที่ไม่ใช่ ULID ทุกตำแหน่ง (กัน user input หลุด)", () => {
    expect(() => componentContainerName("nope!", deploymentId, componentId)).toThrow();
    expect(() => componentContainerName(projectId, deploymentId, "../evil")).toThrow();
    expect(() => componentImageName(projectId, componentId, "not-a-sha", deploymentId)).toThrow();
    expect(() => deploymentNetworkName(projectId, "x; rm -rf /")).toThrow();
    expect(() => componentVolumeName(projectId, "bad", volumeId)).toThrow();
  });

  test("componentLabels = deploymentLabels + componentId", () => {
    expect(componentLabels(projectId, deploymentId, componentId)).toEqual({
      "platform.managed": "true",
      "platform.project_id": projectId,
      "platform.deployment_id": deploymentId,
      "platform.component_id": componentId,
    });
  });
});

// ---------------------------------------------------------------------------
// คำนำหน้าที่อ่านออกได้จากชื่อ project (ตกแต่งเท่านั้น — ULID ยังเป็นตัวชี้ขาด)
// ---------------------------------------------------------------------------

describe("projectSlug", () => {
  test("ชื่อทั่วไป → slug ที่ Docker รับได้", () => {
    expect(projectSlug("Giveme")).toBe("giveme");
    expect(projectSlug("DB Zayn")).toBe("db-zayn");
    expect(projectSlug("zayn-console")).toBe("zayn-console");
  });

  test("อักขระที่ Docker ไม่รับถูกตัดทิ้ง และไม่ทิ้งขีดค้างหัว/ท้าย", () => {
    expect(projectSlug("  My App!!  ")).toBe("my-app");
    expect(projectSlug("a/b:c")).toBe("a-b-c");
  });

  test("ชื่อที่ไม่เหลืออักขระใช้ได้ (เช่นภาษาไทยล้วน) → ว่าง = กลับไปใช้ชื่อรูปแบบเดิม", () => {
    expect(projectSlug("ทดสอบ")).toBe("");
    expect(projectSlug("")).toBe("");
    expect(projectSlug(null)).toBe("");
  });

  test("ยาวเกินถูกตัด และไม่ลงท้ายด้วยขีด", () => {
    const slug = projectSlug("this-is-a-very-long-project-name-indeed");
    expect(slug.length).toBeLessThanOrEqual(16);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("containerName — คำนำหน้าที่อ่านออก", () => {
  const pid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const did = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

  test("มีชื่อ project → <slug>-zx-<ids> และยังมี ULID ครบ", () => {
    const name = containerName(pid, did, "Giveme");
    expect(name).toBe(`giveme-zx-${pid.toLowerCase()}-${did.toLowerCase()}`);
  });

  test("ไม่ส่งชื่อ / ชื่อใช้ไม่ได้ → รูปแบบเดิมเป๊ะ (backward compatible)", () => {
    const legacy = `zx-${pid.toLowerCase()}-${did.toLowerCase()}`;
    expect(containerName(pid, did)).toBe(legacy);
    expect(containerName(pid, did, "ทดสอบ")).toBe(legacy);
  });

  test("component: มีทั้งชื่อ project และชื่อ component ให้อ่านออก", () => {
    const cid = "01BX5ZZKBKACTAV9WEVGEMMVRY";
    const name = componentContainerName(pid, did, cid, {
      projectName: "Giveme",
      componentName: "web",
    });
    expect(name.startsWith("giveme-web-zx-")).toBe(true);
    expect(name.endsWith(cid.toLowerCase())).toBe(true);
  });
});
