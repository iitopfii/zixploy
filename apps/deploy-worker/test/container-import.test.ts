/**
 * นำเข้า container ที่มีอยู่แล้ว → project (migration 0028)
 *
 * จุดที่พังแล้วเสียหายจริง:
 *  - ค่าของ env หลุดเป็น plaintext ลง DB (ตารางนี้ต้องมีแค่ชื่อ key เท่านั้น)
 *  - แตะ container เดิมของผู้ใช้ (ห้ามเด็ดขาด — ของเดิมต้องรันต่อ)
 *  - สร้าง project ที่ config ไม่ตรงกับ container จริง
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import type { DockerCliClient } from "../src/docker/cli-client";
import type { ContainerInspect } from "../src/docker/types";
import { decryptEnvelope } from "../src/github/envelope";
import { createMasterKeys } from "../src/github/master-key";
import { processPendingImports, summarizeInspect } from "../src/imports/loop";

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function inspectFixture(overrides: Partial<ContainerInspect> = {}): ContainerInspect {
  return {
    Id: "abc123",
    Name: "/my-app",
    State: { Status: "running", Running: true },
    RestartCount: 0,
    NetworkSettings: { Networks: {} },
    HostConfig: {
      RestartPolicy: { Name: "always" },
      PortBindings: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] },
    },
    Config: {
      Image: "nginx:1.27-alpine",
      Env: ["PATH=/usr/bin", "APP_KEY=super-secret", "PORT=80"],
      Cmd: ["nginx", "-g", "daemon off;"],
      Labels: {},
    },
    Mounts: [{ Type: "volume", Name: "appdata", Destination: "/data", RW: true }],
    ...overrides,
  };
}

/** mock docker — บันทึกทุก method ที่ถูกเรียก เพื่อพิสูจน์ว่าไม่แตะ container เดิม */
function mockDocker(info: ContainerInspect | null, imageEnv: string[] = ["PATH=/usr/bin"]) {
  const calls: string[] = [];
  const docker = {
    calls,
    inspectContainer: async (id: string) => {
      calls.push(`inspectContainer:${id}`);
      return info;
    },
    inspectImage: async (ref: string) => {
      calls.push(`inspectImage:${ref}`);
      return { Id: "sha256:x", RepoDigests: [], Config: { Labels: null, Env: imageEnv } };
    },
    stopContainer: async (id: string) => {
      calls.push(`stopContainer:${id}`);
    },
    removeContainer: async (id: string) => {
      calls.push(`removeContainer:${id}`);
    },
    startContainer: async (id: string) => {
      calls.push(`startContainer:${id}`);
    },
  };
  return docker as unknown as DockerCliClient & { calls: string[] };
}

function insertRequest(
  db: ReturnType<typeof makeDb>,
  status: "pending" | "confirmed",
  projectName: string | null = null,
) {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO container_imports (id, container_id, container_name, status, project_name, created_at, updated_at)
     VALUES (?, 'abc123', '/my-app', ?, ?, ?, ?)`,
  ).run(id, status, projectName, now, now);
  return id;
}

function row(db: ReturnType<typeof makeDb>, id: string) {
  return db.query("SELECT * FROM container_imports WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;
}

describe("summarizeInspect", () => {
  test("ดึง image / command / restart / port / mount ได้ครบ", () => {
    const s = summarizeInspect(inspectFixture(), ["PATH=/usr/bin"]);
    expect(s.image).toBe("nginx:1.27-alpine");
    expect(s.command).toBe("nginx -g daemon off;");
    expect(s.restartPolicy).toBe("always");
    expect(s.ports).toEqual([{ hostPort: 8080, containerPort: 80 }]);
    expect(s.mounts).toEqual([
      { source: "appdata", target: "/data", type: "volume", readOnly: false },
    ]);
  });

  test("คืนเฉพาะ 'ชื่อ' ของ env และตัด PATH ของ base image ทิ้ง", () => {
    const s = summarizeInspect(inspectFixture(), ["PATH=/usr/bin"]);
    expect(s.envKeys).toEqual(["APP_KEY", "PORT"]);
    // ไม่มีค่าใด ๆ ติดมากับ summary
    expect(JSON.stringify(s)).not.toContain("super-secret");
  });

  /**
   * บทเรียนจาก Docker จริง: nginx ตั้ง NGINX_VERSION/NJS_RELEASE ฯลฯ ไว้ใน image
   * ถ้าไม่กรองจะได้ของที่ผู้ใช้ไม่ได้ตั้งติดมาเป็นสิบตัว จนแยกไม่ออกว่าอะไรคือ config ของตัวเอง
   */
  test("กรอง env ที่มาจาก base image ออกทั้งหมด เหลือเฉพาะที่ผู้ใช้ตั้ง", () => {
    const info = inspectFixture({
      Config: {
        Image: "nginx:1.27-alpine",
        Env: [
          "PATH=/usr/bin",
          "NGINX_VERSION=1.27.5",
          "NJS_RELEASE=1",
          "APP_KEY=super-secret",
          "PORT=80",
        ],
        Cmd: ["nginx"],
        Labels: {},
      },
    });
    const s = summarizeInspect(info, ["PATH=/usr/bin", "NGINX_VERSION=1.27.5", "NJS_RELEASE=1"]);
    expect(s.envKeys).toEqual(["APP_KEY", "PORT"]);
  });

  test("key ชื่อเดียวกับ image แต่ค่าต่าง = ผู้ใช้ override เอง ต้องเก็บไว้", () => {
    const info = inspectFixture({
      Config: {
        Image: "nginx:1.27-alpine",
        Env: ["NGINX_VERSION=9.9.9-custom", "APP_KEY=x"],
        Cmd: ["nginx"],
        Labels: {},
      },
    });
    const s = summarizeInspect(info, ["NGINX_VERSION=1.27.5"]);
    expect(s.envKeys).toEqual(["NGINX_VERSION", "APP_KEY"]);
  });
});

describe("ขั้นตอน inspect (pending → inspected)", () => {
  test("เก็บ metadata ให้ผู้ใช้ตรวจ โดยไม่มีค่า env ใน DB", async () => {
    const db = makeDb();
    const id = insertRequest(db, "pending");
    const docker = mockDocker(inspectFixture());

    await processPendingImports(db, docker, null);

    const r = row(db, id);
    expect(r.status).toBe("inspected");
    expect(r.image).toBe("nginx:1.27-alpine");
    expect(JSON.parse(r.env_keys as string)).toEqual(["APP_KEY", "PORT"]);
    expect(JSON.parse(r.ports as string)).toEqual([{ hostPort: 8080, containerPort: 80 }]);

    // ค่าลับต้องไม่โผล่ในตารางนี้เลยไม่ว่าคอลัมน์ไหน
    const dump = JSON.stringify(r);
    expect(dump).not.toContain("super-secret");
  });

  test("ไม่แตะ container เดิม — เรียกแค่ inspect เท่านั้น", async () => {
    const db = makeDb();
    insertRequest(db, "pending");
    const docker = mockDocker(inspectFixture());

    await processPendingImports(db, docker, null);

    // อ่านได้อย่างเดียว: inspect container + image เท่านั้น ไม่มี start/stop/remove
    expect(docker.calls).toEqual(["inspectContainer:abc123", "inspectImage:nginx:1.27-alpine"]);
  });

  test("container หายไปแล้ว → failed พร้อมเหตุผล (ไม่ค้าง pending ตลอดกาล)", async () => {
    const db = makeDb();
    const id = insertRequest(db, "pending");

    await processPendingImports(db, mockDocker(null), null);

    const r = row(db, id);
    expect(r.status).toBe("failed");
    expect(String(r.failure_message)).toContain("ไม่พบ container");
  });
});

describe("ขั้นตอน import (confirmed → done)", () => {
  test("สร้าง project + component ตรงกับ container จริง", async () => {
    const db = makeDb();
    const id = insertRequest(db, "confirmed", "my-imported-app");

    await processPendingImports(db, mockDocker(inspectFixture()), null);

    const r = row(db, id);
    expect(r.status).toBe("done");
    expect(r.project_id).toBeTruthy();

    const project = db
      .query("SELECT * FROM projects WHERE id = ?")
      .get(r.project_id as string) as Record<string, unknown>;
    expect(project.name).toBe("my-imported-app");
    expect(project.mode).toBe("compose");
    expect(project.internal_port).toBe(80);
    expect(project.exposed_port).toBe(8080);
    expect(project.restart_policy).toBe("always");

    const comp = db
      .query("SELECT * FROM project_components WHERE project_id = ?")
      .get(r.project_id as string) as Record<string, unknown>;
    expect(comp.source_kind).toBe("image");
    expect(comp.image_ref).toBe("nginx:1.27-alpine");
    expect(comp.command).toBe("nginx -g daemon off;");
    expect(comp.is_web).toBe(1);
    expect(comp.web_port).toBe(80);
  });

  test("env ถูกเข้ารหัสก่อนลง DB และถอดกลับได้ค่าเดิม", async () => {
    const db = makeDb();
    const keys = await createMasterKeys(1, { 1: new Uint8Array(32).fill(0x42) });
    const id = insertRequest(db, "confirmed", "app");

    await processPendingImports(db, mockDocker(inspectFixture()), keys);

    const projectId = row(db, id).project_id as string;
    const vars = db
      .query("SELECT key, value_ciphertext FROM environment_variables WHERE project_id = ?")
      .all(projectId) as Array<{ key: string; value_ciphertext: Buffer }>;

    expect(vars.map((v) => v.key).sort()).toEqual(["APP_KEY", "PORT"]);

    // ciphertext ต้องไม่ใช่ plaintext
    const appKey = vars.find((v) => v.key === "APP_KEY");
    expect(appKey?.value_ciphertext.toString("utf8")).not.toContain("super-secret");

    // แต่ถอดกลับได้ค่าเดิมด้วย AAD เดียวกับที่ระบบใช้
    const plain = await decryptEnvelope(
      keys,
      new Uint8Array(appKey?.value_ciphertext as Buffer),
      `env:${projectId}:APP_KEY`,
    );
    expect(plain).toBe("super-secret");
  });

  test("ไม่มี master key → สร้าง project ได้แต่ไม่มี env (ไม่เก็บ plaintext แทน)", async () => {
    const db = makeDb();
    const id = insertRequest(db, "confirmed", "app");

    await processPendingImports(db, mockDocker(inspectFixture()), null);

    const projectId = row(db, id).project_id as string;
    const count = db
      .query("SELECT count(*) c FROM environment_variables WHERE project_id = ?")
      .get(projectId) as { c: number };
    expect(count.c).toBe(0);
  });

  test("ไม่แตะ container เดิมตอน import — ของเดิมยังรันต่อ", async () => {
    const db = makeDb();
    insertRequest(db, "confirmed", "app");
    const docker = mockDocker(inspectFixture());

    await processPendingImports(db, docker, null);

    expect(docker.calls.some((c) => c.startsWith("stopContainer"))).toBe(false);
    expect(docker.calls.some((c) => c.startsWith("removeContainer"))).toBe(false);
  });

  test("ไม่ตั้งชื่อเอง → ใช้ชื่อ container (ตัด / นำหน้าออก)", async () => {
    const db = makeDb();
    const id = insertRequest(db, "confirmed", null);

    await processPendingImports(db, mockDocker(inspectFixture()), null);

    const project = db
      .query("SELECT name FROM projects WHERE id = ?")
      .get(row(db, id).project_id as string) as { name: string };
    expect(project.name).toBe("my-app");
  });

  test("container ไม่มี port → project ไม่มี web component (ไม่เดาว่าเป็นเว็บ)", async () => {
    const db = makeDb();
    const id = insertRequest(db, "confirmed", "worker-app");
    const info = inspectFixture({ HostConfig: { RestartPolicy: { Name: "always" } } });

    await processPendingImports(db, mockDocker(info), null);

    const comp = db
      .query("SELECT is_web, role FROM project_components WHERE project_id = ?")
      .get(row(db, id).project_id as string) as { is_web: number; role: string };
    expect(comp.is_web).toBe(0);
    expect(comp.role).toBe("app");
  });
});
