/**
 * Managed service catalog — Phase 10 (one-click databases)
 *
 * "template" ของ database สำเร็จรูปที่ผู้ใช้กดเลือกได้ทันทีโดยไม่ต้องเขียน Dockerfile
 * ใช้ร่วมกันระหว่าง control-api (validate + สร้าง record) และ deploy-worker (provision container)
 *
 * Security — สำคัญมาก:
 * - ทุก command/healthcheck ที่มี credential ใช้ **shell expansion ของตัวแปรที่อยู่ใน container**
 *   (`"$POSTGRES_PASSWORD"`) ไม่ใช่การแทนค่าจริงลงไปในสตริง
 *   → รหัสผ่านไม่เคยปรากฏใน `docker create` argv, ไม่เคยอยู่ใน HostConfig.Cmd/Healthcheck
 *     ที่ `docker inspect` แสดง และไม่เคยหลุดเข้า worker log
 * - image ทุกตัว pin ด้วย tag ที่ระบุไว้ใน versions เท่านั้น — ไม่รับ image ref จากผู้ใช้
 *   (ไม่งั้นกลายเป็นช่องรัน container อะไรก็ได้บน host)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const SERVICE_TYPES = [
  "postgres",
  "mysql",
  "mariadb",
  "redis",
  "mongodb",
  "libsql",
] as const;

export type ServiceType = (typeof SERVICE_TYPES)[number];

export type ServiceCategory = "sql" | "nosql" | "cache";

/**
 * ค่าที่ generate ตอนสร้าง service — เก็บเข้ารหัสใน DB
 * ชื่อ field เป็นกลาง ๆ ไม่ผูกกับ database ชนิดใดชนิดหนึ่ง (template map เป็น env เอง)
 */
export interface ServiceCredentials {
  username: string;
  password: string;
  database: string;
}

export interface ServiceTemplate {
  type: ServiceType;
  displayName: string;
  /** อธิบายสั้น ๆ ว่าเหมาะกับงานแบบไหน — แสดงในการ์ดเลือก template */
  tagline: string;
  category: ServiceCategory;
  /** image repository ไม่รวม tag */
  image: string;
  /** tag ที่อนุญาต — ตัวแรกเป็น default */
  versions: readonly string[];
  /** port ที่ service ฟังใน container */
  internalPort: number;
  /** path ที่ต้อง mount volume เพื่อให้ข้อมูลอยู่รอดหลัง recreate container */
  dataPath: string;
  /** scheme ของ connection URI เช่น "postgresql" */
  uriScheme: string;
  /** true = ต้องมี username/password (libSQL ใช้ basic auth ผ่าน header ไม่ใช่ URI userinfo) */
  usesUriCredentials: boolean;
  /** env ที่ส่งให้ container ตอน create */
  env(credentials: ServiceCredentials): Record<string, string>;
  /**
   * override entrypoint/command — คืน undefined เมื่อใช้ default ของ image
   * ถ้าต้องอ้าง credential ต้องผ่าน `sh -c` + shell expansion เท่านั้น (ดู comment บนสุด)
   */
  command?(): string[] | undefined;
  /** Docker HEALTHCHECK — Docker รันเองในคอนเทนเนอร์ ไม่ต้อง poll จาก worker */
  healthCmd(): string[];
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const POSTGRES: ServiceTemplate = {
  type: "postgres",
  displayName: "PostgreSQL",
  tagline: "ฐานข้อมูลเชิงสัมพันธ์ที่ครบเครื่องที่สุด เหมาะกับงานทั่วไป",
  category: "sql",
  image: "postgres",
  versions: ["17-alpine", "16-alpine", "15-alpine"],
  internalPort: 5432,
  dataPath: "/var/lib/postgresql/data",
  uriScheme: "postgresql",
  usesUriCredentials: true,
  env: (c) => ({
    POSTGRES_USER: c.username,
    POSTGRES_PASSWORD: c.password,
    POSTGRES_DB: c.database,
    // ไม่ให้ initdb เขียนลง root ของ volume ตรง ๆ — บาง volume driver ทิ้ง lost+found ไว้
    // ทำให้ initdb ปฏิเสธว่า directory ไม่ว่าง
    PGDATA: "/var/lib/postgresql/data/pgdata",
  }),
  // pg_isready อ่านค่าจาก env ใน container เอง — ไม่มี secret ในสตริงคำสั่ง
  healthCmd: () => ["CMD-SHELL", 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" -h 127.0.0.1'],
};

const MYSQL: ServiceTemplate = {
  type: "mysql",
  displayName: "MySQL",
  tagline: "มาตรฐานที่ app ส่วนใหญ่รองรับ เหมาะกับ Laravel/WordPress",
  category: "sql",
  image: "mysql",
  versions: ["8.4", "8.0"],
  internalPort: 3306,
  dataPath: "/var/lib/mysql",
  uriScheme: "mysql",
  usesUriCredentials: true,
  env: (c) => ({
    MYSQL_ROOT_PASSWORD: c.password,
    MYSQL_DATABASE: c.database,
    MYSQL_USER: c.username,
    MYSQL_PASSWORD: c.password,
  }),
  healthCmd: () => [
    "CMD-SHELL",
    'mysqladmin ping -h 127.0.0.1 -u root -p"$MYSQL_ROOT_PASSWORD" --silent',
  ],
};

const MARIADB: ServiceTemplate = {
  type: "mariadb",
  displayName: "MariaDB",
  tagline: "ทางเลือกแทน MySQL ที่เบากว่าและเป็น open source เต็มตัว",
  category: "sql",
  image: "mariadb",
  versions: ["11.4", "10.11"],
  internalPort: 3306,
  dataPath: "/var/lib/mysql",
  uriScheme: "mysql",
  usesUriCredentials: true,
  env: (c) => ({
    MARIADB_ROOT_PASSWORD: c.password,
    MARIADB_DATABASE: c.database,
    MARIADB_USER: c.username,
    MARIADB_PASSWORD: c.password,
  }),
  // mariadb image มี healthcheck.sh มาให้ตั้งแต่ 10.6 — ไม่ต้องส่ง credential เลย
  healthCmd: () => ["CMD-SHELL", "healthcheck.sh --connect --innodb_initialized"],
};

const REDIS: ServiceTemplate = {
  type: "redis",
  displayName: "Redis",
  tagline: "in-memory store สำหรับ cache, session และ queue",
  category: "cache",
  image: "redis",
  versions: ["7-alpine", "8-alpine"],
  internalPort: 6379,
  dataPath: "/data",
  uriScheme: "redis",
  usesUriCredentials: true,
  env: (c) => ({ REDIS_PASSWORD: c.password }),
  // official image ไม่มี env สำหรับตั้งรหัสผ่าน ต้องส่งผ่าน --requirepass
  // ใช้ sh -c + expansion เพื่อไม่ให้รหัสผ่านค้างอยู่ใน Cmd ที่ docker inspect อ่านได้
  // appendonly=yes ให้ข้อมูลอยู่รอดหลัง restart (default ของ image คือไม่ persist)
  command: () => ["sh", "-c", 'exec redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes'],
  // REDISCLI_AUTH แทน -a เพื่อไม่ให้ redis-cli เตือนเรื่องรหัสผ่านบน command line
  healthCmd: () => ["CMD-SHELL", 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping | grep -q PONG'],
};

const MONGODB: ServiceTemplate = {
  type: "mongodb",
  displayName: "MongoDB",
  tagline: "document database เหมาะกับข้อมูลที่ schema ยืดหยุ่น",
  category: "nosql",
  image: "mongo",
  versions: ["8", "7"],
  internalPort: 27017,
  dataPath: "/data/db",
  uriScheme: "mongodb",
  usesUriCredentials: true,
  env: (c) => ({
    MONGO_INITDB_ROOT_USERNAME: c.username,
    MONGO_INITDB_ROOT_PASSWORD: c.password,
    MONGO_INITDB_DATABASE: c.database,
  }),
  healthCmd: () => [
    "CMD-SHELL",
    'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" ' +
      '--authenticationDatabase admin --eval "db.adminCommand({ping:1}).ok" | grep -q 1',
  ],
};

const LIBSQL: ServiceTemplate = {
  type: "libsql",
  displayName: "libSQL",
  tagline: "SQLite ที่ต่อผ่านเครือข่ายได้ เบามาก เหมาะกับ app ขนาดเล็ก-กลาง",
  category: "sql",
  image: "ghcr.io/tursodatabase/libsql-server",
  versions: ["latest"],
  internalPort: 8080,
  dataPath: "/var/lib/sqld",
  // ต่อผ่าน HTTP ไม่ใช่ TCP protocol เฉพาะ — client library ใช้ URL แบบนี้
  uriScheme: "http",
  // auth เป็น HTTP Basic ผ่าน header ไม่ใช่ userinfo ใน URI
  usesUriCredentials: false,
  env: (c) => ({
    SQLD_NODE: "primary",
    // ไฟล์ฐานข้อมูลอยู่ใต้ dataPath ที่ mount volume ไว้ — ข้อมูลจึงอยู่รอดหลัง recreate
    SQLD_DB_PATH: "/var/lib/sqld/data.sqld",
    SQLD_HTTP_LISTEN_ADDR: "0.0.0.0:8080",
    // basic auth ในรูป "user:password" ตามที่ sqld คาดหวัง
    SQLD_HTTP_AUTH: `basic:${c.username}:${c.password}`,
  }),
  // image เป็น distroless ไม่มี shell/curl — ใช้ sqld เองตรวจว่า process ยังอยู่ไม่ได้
  // จึงพึ่ง Docker restart policy + reconciler แทน (ดู healthCmd = [] หมายถึงไม่ตั้ง HEALTHCHECK)
  healthCmd: () => [],
};

export const SERVICE_CATALOG: Readonly<Record<ServiceType, ServiceTemplate>> = Object.freeze({
  postgres: POSTGRES,
  mysql: MYSQL,
  mariadb: MARIADB,
  redis: REDIS,
  mongodb: MONGODB,
  libsql: LIBSQL,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isServiceType(value: string): value is ServiceType {
  return (SERVICE_TYPES as readonly string[]).includes(value);
}

export function getTemplate(type: ServiceType): ServiceTemplate {
  return SERVICE_CATALOG[type];
}

/**
 * ตรวจว่า version ที่ขออยู่ใน allowlist ของ template — กันการยัด image tag อะไรก็ได้
 * ไม่ระบุ version → คืน default (ตัวแรกใน versions)
 */
export function resolveVersion(type: ServiceType, version?: string | null): string {
  const template = getTemplate(type);
  if (!version) return template.versions[0] as string;
  if (!template.versions.includes(version)) {
    throw new Error(
      `version "${version}" ไม่รองรับสำหรับ ${template.displayName} — ใช้ได้: ${template.versions.join(", ")}`,
    );
  }
  return version;
}

/** image ref เต็มที่ใช้ pull/create — ประกอบจาก catalog เท่านั้น ไม่รับ input ตรง ๆ */
export function serviceImage(type: ServiceType, version: string): string {
  return `${getTemplate(type).image}:${resolveVersion(type, version)}`;
}

/**
 * connection URI สำหรับให้ผู้ใช้ copy ไปใส่ใน app
 *
 * host คือชื่อ container ใน Docker network (ต่อจาก app อื่นในเครื่อง) หรือ IP ของ server
 * (เมื่อเปิด port ออกภายนอก) — ผู้เรียกเป็นคนตัดสินใจว่าจะสร้างแบบไหน
 */
export function connectionUri(
  type: ServiceType,
  credentials: ServiceCredentials,
  host: string,
  port: number,
): string {
  const template = getTemplate(type);
  const user = encodeURIComponent(credentials.username);
  const pass = encodeURIComponent(credentials.password);

  if (!template.usesUriCredentials) {
    return `${template.uriScheme}://${host}:${port}`;
  }

  switch (type) {
    case "redis":
      // redis ไม่มี database name ใน URI (ใช้เลข db index แทน) และ username เป็น optional
      return `redis://default:${pass}@${host}:${port}`;
    case "mongodb":
      // authSource=admin จำเป็นเพราะ root user ถูกสร้างใน admin database
      return `mongodb://${user}:${pass}@${host}:${port}/${credentials.database}?authSource=admin`;
    default:
      return `${template.uriScheme}://${user}:${pass}@${host}:${port}/${credentials.database}`;
  }
}
