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
