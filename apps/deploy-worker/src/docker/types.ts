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
  /** Named volumes ที่ต้องการ mount (Phase 7) — ต้องสร้าง volume ใน Docker ก่อนเรียก createContainer */
  volumes?: VolumeMount[];
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
  NetworkSettings: {
    /** key = network name — ตรวจสอบจริงกับ Docker Desktop */
    Networks: Record<string, { IPAddress: string }>;
  };
}

export interface ImageInspect {
  Id: string;
  RepoDigests: string[];
  /** ownership labels (ADR-0005) — อยู่ใต้ Config.Labels ไม่ใช่ top-level (ตรวจสอบจริงกับ Docker Desktop) */
  Config: {
    Labels: Record<string, string> | null;
  };
}

export interface ContainerSummary {
  ID: string;
  Names: string;
  Image: string;
  Labels: string;
}

export interface ImageSummary {
  ID: string;
  Repository: string;
  Tag: string;
}

// ---------------------------------------------------------------------------
// Volume types (Phase 7)
// ---------------------------------------------------------------------------

/** Volume ที่ต้อง mount เมื่อสร้าง container — ชื่อ Docker volume ต้องมีอยู่แล้วก่อน createContainer */
export interface VolumeMount {
  /** Docker volume name (จาก volumes.docker_name — สร้างโดย volumeName() ห้ามใช้ user input) */
  dockerName: string;
  /** Absolute Linux path ใน container — ตรวจแล้วด้วย validateMountPath() */
  mountPath: string;
  readOnly?: boolean;
}

export interface VolumeInspect {
  Name: string;
  Driver: string;
  Mountpoint: string;
  Labels: Record<string, string> | null;
}

export interface VolumeSummary {
  Name: string;
  Driver: string;
  Labels: string;
}
