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
  /**
   * DNS alias บน network หลัก (Phase 18 — multi-container) — component อื่นใน deployment
   * เดียวกัน resolve ชื่อนี้ไปหา container นี้ได้ (เช่น `redis://cache:6379`) แบบ compose
   * ค่าต้องผ่าน DNS-label regex ใน assertContainerConfigSafe (string เดียวจาก user ที่ถึง argv)
   */
  networkAliases?: string[];
  /** Named volumes ที่ต้องการ mount (Phase 7) — ต้องสร้าง volume ใน Docker ก่อนเรียก createContainer */
  volumes?: VolumeMount[];
  /**
   * Publish port ออก host (Phase 10 — managed services)
   *
   * bind กับ 0.0.0.0 เสมอตามที่ Docker default ทำ — ผู้ใช้ที่เปิด port ต้องรู้ตัวว่าเปิดออก
   * อินเทอร์เน็ต (API เตือนตอนตั้งค่า) ไม่ silently bind 127.0.0.1 ซึ่งจะทำให้ต่อจากเครื่องอื่นไม่ได้
   * โดยไม่มีอะไรบอก
   *
   * ไม่มี field นี้ = ไม่เปิด port เลย (default ที่ปลอดภัย — เข้าถึงได้เฉพาะใน Docker network)
   */
  publishPorts?: Array<{ hostPort: number; containerPort: number }>;
  /**
   * Docker HEALTHCHECK — Docker รันคำสั่งนี้เองในคอนเทนเนอร์เป็นระยะ
   *
   * ใช้แทนการ poll จาก worker เพราะ (1) สถานะติดกับตัว container ตลอดอายุ ไม่ใช่แค่ตอน provision
   * (2) reconciler/monitoring อ่าน State.Health ได้ฟรี (3) คำสั่งรันในคอนเทนเนอร์ จึงอ้าง
   * env ที่มี credential ได้โดยไม่ต้องส่งค่าจริงผ่าน argv ของ host
   *
   * cmd[0] = "CMD" หรือ "CMD-SHELL" ตามรูปแบบของ Docker
   */
  healthCheck?: {
    cmd: string[];
    intervalSec: number;
    timeoutSec: number;
    retries: number;
    startPeriodSec: number;
  };
}

export interface ContainerInspect {
  Id: string;
  Name: string;
  State: {
    Status: string;
    Running: boolean;
    /**
     * Phase 10 — มีเฉพาะ container ที่ตั้ง HEALTHCHECK ไว้
     * Status: "starting" | "healthy" | "unhealthy"
     */
    Health?: {
      Status: string;
      FailingStreak?: number;
    };
  };
  /** top-level field ใน `docker inspect` — ไม่ได้อยู่ใต้ State (ตรวจสอบจริงกับ Docker Desktop) */
  RestartCount: number;
  NetworkSettings: {
    /** key = network name — ตรวจสอบจริงกับ Docker Desktop */
    Networks: Record<string, { IPAddress: string }>;
  };
  /**
   * Phase 9 (monitoring) — memory limit จริงที่ตั้งไว้ตอน create, 0 = ไม่จำกัด
   * ต้องอ่านจากที่นี่ ไม่ใช่จาก `docker stats` เพราะ stats รายงาน limit ของ container ที่ไม่ได้
   * จำกัดเป็นขนาด RAM ทั้งเครื่อง ทำให้แยกไม่ออกว่า "จำกัดเท่า RAM เครื่อง" หรือ "ไม่ได้จำกัด"
   *
   * optional เพราะ inspect ของ Docker รุ่นเก่า/บาง context อาจไม่มี field นี้
   */
  HostConfig?: {
    Memory?: number;
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

/**
 * หนึ่งบรรทัดจาก `docker ps -a --format "{{json .}}"` แบบเต็ม — Docker inventory (หน้า Docker)
 * ทุก field เป็นข้อความ format มาเพื่อคนอ่าน (เช่น Status="Up 2 hours (healthy)") — เก็บไว้แสดงผลตรง ๆ
 */
export interface ContainerPsEntry {
  ID: string;
  Names: string;
  Image: string;
  State: string;
  Status: string;
  Ports: string;
  Labels: string;
  Networks: string;
  CreatedAt: string;
}

/** หนึ่งบรรทัดจาก `docker images --format "{{json .}}"` — Docker inventory (หน้า Docker) */
export interface ImageLsEntry {
  ID: string;
  Repository: string;
  Tag: string;
  Size: string;
  CreatedSince: string;
}

/**
 * หนึ่งบรรทัดจาก `docker stats --no-stream --format "{{json .}}"` — Phase 9 (monitoring)
 *
 * ทุก field เป็น **string ที่ format มาเพื่อคนอ่าน** ไม่ใช่ตัวเลขดิบ เช่น CPUPerc="0.05%",
 * MemUsage="19.3MiB / 7.772GiB" — ต้อง parse ก่อนใช้ (ดู metrics/containers.ts)
 */
export interface DockerStatsEntry {
  ID: string;
  Name: string;
  CPUPerc: string;
  MemUsage: string;
  MemPerc: string;
  NetIO: string;
  BlockIO: string;
  PIDs: string;
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
