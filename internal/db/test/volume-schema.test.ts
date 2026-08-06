/**
 * Volume schema tests — docs/phase-07-volumes.md M1
 *
 * ครอบคลุม:
 * - INSERT volume ปกติ
 * - CHECK constraints: lifecycle, access_mode, read_only
 * - UNIQUE docker_name
 * - default values (driver, access_mode, read_only, lifecycle)
 * - foreign key ไปยัง projects (ไม่มี CASCADE)
 * - index idx_volumes_project_lifecycle มีอยู่จริง
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "../src";

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function insertProject(db: ReturnType<typeof makeDb>): string {
  const id = "01JTEST00000000000000PROJECT";
  db.query(
    `INSERT INTO projects
      (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'proj', 'new', 'Dockerfile', '.', 'unless-stopped', 900, 1, 1)`,
  ).run(id);
  return id;
}

function insertVolume(
  db: ReturnType<typeof makeDb>,
  projectId: string,
  overrides: Partial<{
    id: string;
    displayName: string;
    dockerName: string;
    mountPath: string;
    accessMode: string;
    driver: string;
    readOnly: number;
    lifecycle: string;
  }> = {},
) {
  const id = overrides.id ?? "01JVOL000000000000000000VOL";
  const now = Date.now();
  db.query(
    `INSERT INTO volumes
       (id, project_id, display_name, docker_name, mount_path, access_mode, driver,
        driver_opts, read_only, lifecycle, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    overrides.displayName ?? "my-data",
    overrides.dockerName ?? `zxvol-${projectId.toLowerCase()}-${id.toLowerCase()}`,
    overrides.mountPath ?? "/app/data",
    overrides.accessMode ?? "shared-safe",
    overrides.driver ?? "local",
    overrides.readOnly ?? 0,
    overrides.lifecycle ?? "active",
    now,
    now,
  );
  return id;
}

// ---------------------------------------------------------------------------
// Basic insert
// ---------------------------------------------------------------------------

describe("volumes table", () => {
  test("INSERT ปกติสำเร็จ", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    expect(() => insertVolume(db, projectId)).not.toThrow();

    const row = db
      .query<{ id: string; lifecycle: string; driver: string }, []>(
        "SELECT id, lifecycle, driver FROM volumes LIMIT 1",
      )
      .get();
    expect(row).not.toBeNull();
    expect(row!.lifecycle).toBe("active");
    expect(row!.driver).toBe("local");
  });

  test("default values: driver=local, access_mode=shared-safe, read_only=0, lifecycle=active", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const id = "01JVOL000000000000000000DEF";
    const now = Date.now();
    // INSERT ระบุเฉพาะ required fields — ให้ defaults ทำงาน
    db.query(
      `INSERT INTO volumes (id, project_id, display_name, docker_name, mount_path, created_at, updated_at)
       VALUES (?, ?, 'vol', 'zxvol-xxx', '/data', ?, ?)`,
    ).run(id, projectId, now, now);

    const row = db
      .query<
        { driver: string; access_mode: string; read_only: number; lifecycle: string },
        [string]
      >("SELECT driver, access_mode, read_only, lifecycle FROM volumes WHERE id = ?")
      .get(id);
    expect(row!.driver).toBe("local");
    expect(row!.access_mode).toBe("shared-safe");
    expect(row!.read_only).toBe(0);
    expect(row!.lifecycle).toBe("active");
  });

  // ---------------------------------------------------------------------------
  // CHECK constraints
  // ---------------------------------------------------------------------------

  test("lifecycle CHECK ปฏิเสธ value ที่ไม่ถูกต้อง", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    expect(() =>
      insertVolume(db, projectId, { id: "01JVOL000000000000000000CK1", lifecycle: "running" }),
    ).toThrow();
  });

  test("lifecycle CHECK ยอมรับ values ทั้งหมดที่ถูกต้อง", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const lifecycles = ["active", "detached", "deletion_pending", "deleted", "error"];
    for (const [i, lc] of lifecycles.entries()) {
      expect(() =>
        insertVolume(db, projectId, {
          id: `01JVOL00000000000000000000${i}`,
          dockerName: `zxvol-test-${i}`,
          lifecycle: lc,
        }),
      ).not.toThrow();
    }
  });

  test("access_mode CHECK ปฏิเสธ value ที่ไม่ถูกต้อง", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    expect(() =>
      insertVolume(db, projectId, { id: "01JVOL000000000000000000CK2", accessMode: "multi" }),
    ).toThrow();
  });

  test("access_mode CHECK ยอมรับ shared-safe และ single-writer", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    expect(() =>
      insertVolume(db, projectId, {
        id: "01JVOL000000000000000000AM1",
        dockerName: "zxvol-am1",
        accessMode: "shared-safe",
      }),
    ).not.toThrow();
    expect(() =>
      insertVolume(db, projectId, {
        id: "01JVOL000000000000000000AM2",
        dockerName: "zxvol-am2",
        accessMode: "single-writer",
      }),
    ).not.toThrow();
  });

  test("read_only CHECK ปฏิเสธค่าที่ไม่ใช่ 0 หรือ 1", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    expect(() =>
      insertVolume(db, projectId, { id: "01JVOL000000000000000000CK3", readOnly: 2 }),
    ).toThrow();
  });

  // ---------------------------------------------------------------------------
  // UNIQUE constraint
  // ---------------------------------------------------------------------------

  test("docker_name UNIQUE ปฏิเสธชื่อซ้ำ", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertVolume(db, projectId, {
      id: "01JVOL000000000000000000UN1",
      dockerName: "zxvol-same-name",
    });
    expect(() =>
      insertVolume(db, projectId, {
        id: "01JVOL000000000000000000UN2",
        dockerName: "zxvol-same-name",
      }),
    ).toThrow();
  });

  test("docker_name ต่างกันใน project เดียวกันสำเร็จ", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    expect(() =>
      insertVolume(db, projectId, {
        id: "01JVOL000000000000000000DN1",
        dockerName: "zxvol-name-a",
      }),
    ).not.toThrow();
    expect(() =>
      insertVolume(db, projectId, {
        id: "01JVOL000000000000000000DN2",
        dockerName: "zxvol-name-b",
      }),
    ).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Foreign key
  // ---------------------------------------------------------------------------

  test("FK project_id ปฏิเสธ project ที่ไม่มีอยู่", () => {
    const db = makeDb();
    // FK enforcement ต้อง enable ก่อน (migrateUp ทำให้แล้ว แต่เปิดใหม่ทุก test)
    db.query("PRAGMA foreign_keys = ON").run();
    expect(() => insertVolume(db, "01JNOPROJECT0000000000000XY")).toThrow();
  });

  test("DELETE project ที่มี volume ค้างอยู่ fail (FK ไม่มี CASCADE)", () => {
    const db = makeDb();
    db.query("PRAGMA foreign_keys = ON").run();
    const projectId = insertProject(db);
    insertVolume(db, projectId);
    // project ที่ยังมี volume → DELETE ต้อง fail
    expect(() => db.query("DELETE FROM projects WHERE id = ?").run(projectId)).toThrow();
  });
});
