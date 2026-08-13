/**
 * Service catalog tests — Phase 10 M1
 *
 * เน้นคุณสมบัติความปลอดภัยที่ถ้าพลาดแล้วรหัสผ่านหลุด:
 * - command/healthcheck ต้องไม่มีรหัสผ่านจริงฝังอยู่ (ต้องใช้ shell expansion แทน)
 * - image ประกอบจาก catalog เท่านั้น version นอก allowlist ต้องถูกปฏิเสธ
 */

import { describe, expect, test } from "bun:test";
import {
  connectionUri,
  getTemplate,
  isServiceType,
  resolveVersion,
  SERVICE_CATALOG,
  SERVICE_TYPES,
  type ServiceCredentials,
  serviceImage,
} from "../src/services";

const CREDS: ServiceCredentials = {
  username: "zxuser",
  password: "SuperSecret-P4ssw0rd-DoNotLeak",
  database: "appdb",
};

describe("catalog integrity", () => {
  test("ทุกชนิดใน SERVICE_TYPES มี template ครบ", () => {
    for (const type of SERVICE_TYPES) {
      expect(SERVICE_CATALOG[type]).toBeDefined();
      expect(SERVICE_CATALOG[type].type).toBe(type);
    }
  });

  test("ทุก template มี version อย่างน้อยหนึ่งตัวและ port ที่ถูกต้อง", () => {
    for (const type of SERVICE_TYPES) {
      const t = getTemplate(type);
      expect(t.versions.length).toBeGreaterThan(0);
      expect(t.internalPort).toBeGreaterThan(0);
      expect(t.internalPort).toBeLessThanOrEqual(65535);
      expect(t.dataPath.startsWith("/")).toBe(true);
    }
  });

  test("catalog ถูก freeze — แก้ไขตอน runtime ไม่ได้", () => {
    expect(Object.isFrozen(SERVICE_CATALOG)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// คุณสมบัติความปลอดภัยหลัก
// ---------------------------------------------------------------------------

describe("รหัสผ่านต้องไม่ปรากฏใน command/healthcheck", () => {
  test.each([...SERVICE_TYPES])("%s: healthCmd ไม่มีรหัสผ่านจริง", (type) => {
    const cmd = getTemplate(type).healthCmd().join(" ");
    expect(cmd).not.toContain(CREDS.password);
  });

  test.each([...SERVICE_TYPES])("%s: command ไม่มีรหัสผ่านจริง", (type) => {
    const cmd = getTemplate(type).command?.()?.join(" ") ?? "";
    expect(cmd).not.toContain(CREDS.password);
  });

  test("redis ส่งรหัสผ่านผ่าน shell expansion ไม่ใช่ค่าตรง", () => {
    const cmd = getTemplate("redis").command?.() ?? [];
    const joined = cmd.join(" ");
    expect(joined).toContain("$REDIS_PASSWORD");
    expect(joined).not.toContain(CREDS.password);
    // ต้องผ่าน sh -c ไม่งั้น $VAR ไม่ถูกขยาย จะกลายเป็นรหัสผ่านตามตัวอักษร
    expect(cmd[0]).toBe("sh");
    expect(cmd[1]).toBe("-c");
  });

  test("postgres/mysql/mongodb healthcheck อ้าง env ไม่ใช่ค่าจริง", () => {
    expect(getTemplate("postgres").healthCmd().join(" ")).toContain("$POSTGRES_USER");
    expect(getTemplate("mysql").healthCmd().join(" ")).toContain("$MYSQL_ROOT_PASSWORD");
    expect(getTemplate("mongodb").healthCmd().join(" ")).toContain("$MONGO_INITDB_ROOT_PASSWORD");
  });

  test("mariadb ใช้ healthcheck.sh ที่ image เตรียมไว้ — ไม่ต้องอ้าง credential เลย", () => {
    const cmd = getTemplate("mariadb").healthCmd().join(" ");
    expect(cmd).toContain("healthcheck.sh");
    expect(cmd).not.toContain("PASSWORD");
  });

  test("healthcheck ที่อ้าง env ต้องเป็น CMD-SHELL (CMD ไม่ขยายตัวแปร)", () => {
    for (const type of SERVICE_TYPES) {
      const cmd = getTemplate(type).healthCmd();
      if (cmd.length === 0) continue;
      if (cmd.join(" ").includes("$")) {
        expect(cmd[0]).toBe("CMD-SHELL");
      }
    }
  });
});

describe("backupStrategy — dump/restore command ต้องไม่มีรหัสผ่านจริง", () => {
  test.each([...SERVICE_TYPES])("%s: มี backupStrategy ที่ fileExtension ไม่ว่าง", (type) => {
    const strategy = getTemplate(type).backupStrategy();
    expect(strategy.fileExtension.length).toBeGreaterThan(0);
  });

  test.each([...SERVICE_TYPES])("%s: exec mode ต้องผ่าน sh -c เสมอ (ไม่งั้น $VAR ไม่ขยาย)", (type) => {
    const strategy = getTemplate(type).backupStrategy();
    if (strategy.mode !== "exec") return;
    expect(strategy.dumpCmd[0]).toBe("sh");
    expect(strategy.dumpCmd[1]).toBe("-c");
    expect(strategy.restoreCmd[0]).toBe("sh");
    expect(strategy.restoreCmd[1]).toBe("-c");
  });

  test.each([...SERVICE_TYPES])("%s: dumpCmd/restoreCmd ไม่มีรหัสผ่านจริงฝังอยู่", (type) => {
    const strategy = getTemplate(type).backupStrategy();
    if (strategy.mode !== "exec") return;
    expect(strategy.dumpCmd.join(" ")).not.toContain(CREDS.password);
    expect(strategy.restoreCmd.join(" ")).not.toContain(CREDS.password);
  });

  test("postgres/mysql/mariadb/mongodb ที่เป็น exec mode ต้องอ้าง env ผ่าน $VAR", () => {
    for (const type of ["postgres", "mysql", "mariadb", "mongodb"] as const) {
      const strategy = getTemplate(type).backupStrategy();
      if (strategy.mode !== "exec") continue;
      expect(strategy.dumpCmd.join(" ")).toContain("$");
    }
  });

  test("redis/libsql ใช้ file-copy — ไม่มี dump tool ให้ exec (redis เลือกความสม่ำเสมอ, libsql ไม่มี shell)", () => {
    expect(getTemplate("redis").backupStrategy().mode).toBe("file-copy");
    expect(getTemplate("libsql").backupStrategy().mode).toBe("file-copy");
  });

  test("mariadb ใช้ binary mariadb-dump/mariadb ตรง ๆ ไม่พึ่ง mysqldump compat symlink", () => {
    const strategy = getTemplate("mariadb").backupStrategy();
    if (strategy.mode !== "exec") throw new Error("expected exec mode");
    expect(strategy.dumpCmd.join(" ")).toContain("mariadb-dump");
    expect(strategy.restoreCmd.join(" ")).toContain("mariadb ");
  });
});

describe("env mapping", () => {
  test("รหัสผ่านถูกส่งผ่าน env (ที่เดียวที่ควรมี)", () => {
    const env = getTemplate("postgres").env(CREDS);
    expect(env.POSTGRES_PASSWORD).toBe(CREDS.password);
    expect(env.POSTGRES_USER).toBe(CREDS.username);
    expect(env.POSTGRES_DB).toBe(CREDS.database);
  });

  test("postgres ตั้ง PGDATA เป็น subdirectory — กัน initdb ล้มเพราะ volume ไม่ว่าง", () => {
    const template = getTemplate("postgres");
    const pgdata = template.env(CREDS).PGDATA ?? "";
    expect(pgdata).toBe("/var/lib/postgresql/data/pgdata");
    expect(pgdata.startsWith(template.dataPath)).toBe(true);
  });

  test("libsql ตั้ง SQLD_DB_PATH ไว้ใต้ dataPath — ข้อมูลอยู่รอดหลัง recreate", () => {
    const template = getTemplate("libsql");
    const dbPath = template.env(CREDS).SQLD_DB_PATH ?? "";
    expect(dbPath.startsWith(template.dataPath)).toBe(true);
  });

  test("ทุกชนิดมี env อย่างน้อยหนึ่งตัว", () => {
    for (const type of SERVICE_TYPES) {
      expect(Object.keys(getTemplate(type).env(CREDS)).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// version / image
// ---------------------------------------------------------------------------

describe("resolveVersion + serviceImage", () => {
  test("ไม่ระบุ version → ใช้ตัวแรกใน versions", () => {
    expect(resolveVersion("postgres")).toBe(getTemplate("postgres").versions[0] as string);
  });

  test("version ที่อยู่ใน allowlist ผ่าน", () => {
    expect(resolveVersion("mysql", "8.0")).toBe("8.0");
  });

  test("version นอก allowlist → throw (กันยัด image tag อะไรก็ได้)", () => {
    expect(() => resolveVersion("postgres", "13")).toThrow(/ไม่รองรับ/);
  });

  test("พยายามแทรก tag อันตราย → throw", () => {
    expect(() => resolveVersion("postgres", "latest; rm -rf /")).toThrow();
    expect(() => resolveVersion("postgres", "../../evil")).toThrow();
  });

  test("serviceImage ประกอบ repo:tag จาก catalog", () => {
    expect(serviceImage("postgres", "16-alpine")).toBe("postgres:16-alpine");
    expect(serviceImage("libsql", "latest")).toBe("ghcr.io/tursodatabase/libsql-server:latest");
  });

  test("serviceImage ปฏิเสธ version ที่ไม่อนุญาต", () => {
    expect(() => serviceImage("redis", "6")).toThrow();
  });
});

describe("isServiceType", () => {
  test("ชนิดที่มีจริงผ่าน", () => {
    expect(isServiceType("postgres")).toBe(true);
    expect(isServiceType("libsql")).toBe(true);
  });

  test("ชนิดที่ไม่มี → false", () => {
    expect(isServiceType("oracle")).toBe(false);
    expect(isServiceType("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// connection URI
// ---------------------------------------------------------------------------

describe("connectionUri", () => {
  test("postgres — scheme://user:pass@host:port/db", () => {
    expect(connectionUri("postgres", CREDS, "zxsvc-abc", 5432)).toBe(
      `postgresql://zxuser:${encodeURIComponent(CREDS.password)}@zxsvc-abc:5432/appdb`,
    );
  });

  test("mongodb ต้องมี authSource=admin (root user อยู่ใน admin db)", () => {
    const uri = connectionUri("mongodb", CREDS, "host", 27017);
    expect(uri).toContain("authSource=admin");
  });

  test("redis ใช้ user 'default' และไม่มี database name", () => {
    const uri = connectionUri("redis", CREDS, "host", 6379);
    expect(uri).toStartWith("redis://default:");
    expect(uri).not.toContain("appdb");
  });

  test("libsql ไม่ใส่ credential ใน URI (ใช้ basic auth header แทน)", () => {
    const uri = connectionUri("libsql", CREDS, "host", 8080);
    expect(uri).toBe("http://host:8080");
    expect(uri).not.toContain(CREDS.password);
    expect(uri).not.toContain(CREDS.username);
  });

  test("อักขระพิเศษในรหัสผ่านถูก encode — URI ไม่พัง", () => {
    const tricky: ServiceCredentials = {
      username: "us er",
      password: "p@ss:w/rd?#[]",
      database: "db",
    };
    const uri = connectionUri("postgres", tricky, "host", 5432);
    // เครื่องหมายที่มีความหมายใน URI ต้องถูก escape ไม่หลุดมาดิบ ๆ
    expect(uri).not.toContain("p@ss:w/rd?#[]");
    expect(uri).toContain(encodeURIComponent(tricky.password));
    // ต้อง parse กลับได้และได้รหัสผ่านเดิม
    expect(decodeURIComponent(new URL(uri).password)).toBe(tricky.password);
  });
});
