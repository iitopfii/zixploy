/**
 * Docker resource types — shape เท่าที่ M6 pipeline ต้องใช้จริง ไม่ mirror Docker Engine API ทั้งหมด
 */

export interface ContainerCreateParams {
  /** deterministic name จาก containerName(projectId, deploymentId) — ADR-0005 */
  name: string;
  image: string;
  /** ownership labels จาก deploymentLabels() — ADR-0005 */
  labels: Record<string, string>;
  env?: Record<string, string>;
  cmd?: string[];
  cpuLimit?: number | null;
  memoryLimitMb?: number | null;
  /** ป้องกัน fork bomb — default 512 ถ้าไม่ระบุ (threat-model.md) */
  pidsLimit?: number;
  restartPolicy: "no" | "on-failure" | "always" | "unless-stopped";
  networkName: string;
}

export interface ContainerInspect {
  Id: string;
  Name: string;
  State: {
    Status: string;
    Running: boolean;
  };
  /** top-level field ใน `docker inspect` — ไม่ได้อยู่ใต้ State (ตรวจสอบจริงกับ Docker Desktop) */
  RestartCount: number;
}

export interface ImageInspect {
  Id: string;
  RepoDigests: string[];
}

export interface ContainerSummary {
  ID: string;
  Names: string;
  Image: string;
  Labels: string;
}
