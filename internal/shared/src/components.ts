/**
 * Multi-container project components — validation ที่ใช้ร่วมกันทั้ง control-api และ worker (Phase 18)
 *
 * component name = network alias (DNS label) — regex ต้องตรงกับ NETWORK_ALIAS_RE ใน
 * apps/deploy-worker/src/docker/safety.ts เพราะเป็น "string เดียวจาก user ที่ไปถึง argv"
 * (ผ่าน --network-alias) การ validate ที่ control-api เป็นชั้นแรก, ที่ worker เป็น defense-in-depth
 */

/** DNS label: ขึ้นต้นด้วยตัวอักษร, [a-z0-9-], ยาวได้ถึง 31 ตัว — กัน alias ที่ขึ้นด้วย '-' เป็น flag */
export const COMPONENT_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;

export const COMPONENT_SOURCE_KINDS = ["build", "image", "managed_ref"] as const;
export type ComponentSourceKind = (typeof COMPONENT_SOURCE_KINDS)[number];

export const COMPONENT_ROLES = ["web", "worker", "db", "cache", "app", "other"] as const;
export type ComponentRole = (typeof COMPONENT_ROLES)[number];

export const DEP_CONDITIONS = ["started", "healthy"] as const;
export type DepCondition = (typeof DEP_CONDITIONS)[number];

export function isComponentName(name: string): boolean {
  return COMPONENT_NAME_RE.test(name);
}

/**
 * image ref สำหรับ component source_kind='image' — allowlist (Phase 18)
 *
 * ต้องระบุ tag หรือ digest เสมอ (ห้ามปล่อยให้ resolve เป็น "latest" โดยปริยาย = ไม่ deterministic)
 * และห้าม tag = "latest" ตรง ๆ · repo name ต้องเป็น lowercase ตามข้อกำหนดของ Docker
 * รองรับ registry host (ghcr.io, docker.io[:port]) + path หลายชั้น
 */
export function validateImageRef(ref: string): { ok: boolean; reason?: string } {
  if (!ref || ref.length > 255) {
    return { ok: false, reason: "image ref ว่างหรือยาวเกินไป" };
  }

  let name = ref;
  const digestMatch = /@sha256:[a-f0-9]{64}$/.exec(ref);
  if (digestMatch) {
    name = ref.slice(0, digestMatch.index);
  } else {
    const lastColon = ref.lastIndexOf(":");
    const lastSlash = ref.lastIndexOf("/");
    // ":" ต้องมาหลัง "/" ล่าสุด ไม่งั้นเป็น registry:port ไม่ใช่ tag
    if (lastColon <= lastSlash) {
      return { ok: false, reason: "ต้องระบุ tag หรือ digest (ห้ามใช้ latest โดยปริยาย)" };
    }
    const tag = ref.slice(lastColon + 1);
    name = ref.slice(0, lastColon);
    if (tag === "latest") {
      return { ok: false, reason: "ห้ามใช้ tag 'latest' (ไม่ deterministic — ระบุเวอร์ชันหรือ digest)" };
    }
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/.test(tag)) {
      return { ok: false, reason: "รูปแบบ tag ไม่ถูกต้อง" };
    }
  }

  // name = [registry[:port]/]repo[/path...] — lowercase alphanumeric + . _ - คั่นด้วย /
  const namePart = "[a-z0-9]+([._-][a-z0-9]+)*";
  const nameRe = new RegExp(`^${namePart}(:[0-9]+)?(/${namePart})*$`);
  if (!nameRe.test(name)) {
    return { ok: false, reason: "ชื่อ image ไม่ถูกต้อง (ต้องเป็น lowercase)" };
  }
  return { ok: true };
}

/** host ที่ Docker ใช้แทน Docker Hub — ref ที่ไม่ระบุ registry (เช่น "nginx:1.27") ไปที่นี่ */
export const DOCKER_HUB_REGISTRY = "docker.io";

/**
 * registry host ของ image ref ตามกฎเดียวกับ Docker: ส่วนแรกก่อน "/" นับเป็น host ก็ต่อเมื่อมี "."
 * หรือ ":" หรือเป็น "localhost" — ไม่งั้นเป็น namespace บน Docker Hub ("library/nginx", "acme/app")
 */
export function imageRegistry(ref: string): string {
  const slash = ref.indexOf("/");
  if (slash === -1) return DOCKER_HUB_REGISTRY;
  const first = ref.slice(0, slash).toLowerCase();
  if (first !== "localhost" && !first.includes(".") && !first.includes(":")) {
    return DOCKER_HUB_REGISTRY;
  }
  return first === "index.docker.io" || first === "registry-1.docker.io"
    ? DOCKER_HUB_REGISTRY
    : first;
}

/**
 * ตรวจ + normalize registry host ที่ผู้ใช้กรอก — รับ "ghcr.io", "https://ghcr.io/", "registry.local:5000"
 * คืน host lowercase (ไม่มี scheme/path) · alias ของ Docker Hub ทุกแบบกลายเป็น "docker.io"
 */
export function normalizeRegistryHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  host = host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (
    host === "index.docker.io" ||
    host === "registry-1.docker.io" ||
    host.startsWith("index.docker.io/")
  ) {
    return DOCKER_HUB_REGISTRY;
  }
  if (
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/.test(host)
  ) {
    throw new Error("registry ต้องเป็น host เช่น ghcr.io หรือ registry.example.com:5000 (ไม่มี path)");
  }
  return host;
}
