import { describe, expect, test } from "bun:test";
import { ulid } from "../src/id";
import {
  containerName,
  deploymentLabels,
  imageName,
  volumeLabels,
  volumeName,
} from "../src/naming";

const projectId = ulid();
const deploymentId = ulid();
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
