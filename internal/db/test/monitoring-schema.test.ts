/**
 * Monitoring schema tests — Phase 9 M1 (migration 0014)
 *
 * ครอบคลุม:
 * - INSERT host_metrics / container_metrics ปกติ
 * - CHECK constraints (ค่าติดลบ, total ต้อง > 0, running ต้องเป็น 0/1)
 * - PRIMARY KEY dedup: host = ts, container = (project_id, ts)
 * - FK CASCADE: ลบ project แล้ว container_metrics หายตาม
 * - index idx_container_metrics_ts มีอยู่จริง (prune ข้าม project พึ่ง index นี้)
 * - prune ตามช่วงเวลา
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "../src";

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function insertProject(db: ReturnType<typeof makeDb>, id = "01JTEST00000000000000PROJECT"): string {
  db.query(
    `INSERT INTO projects
      (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'proj', 'new', 'Dockerfile', '.', 'unless-stopped', 900, 1, 1)`,
  ).run(id);
  return id;
}

function insertHost(
  db: ReturnType<typeof makeDb>,
  overrides: Partial<{
    ts: number;
    cpuPercent: number;
    memUsed: number;
    memTotal: number;
    diskUsed: number;
    diskTotal: number;
    load1: number;
    cpuCount: number;
  }> = {},
) {
  db.query(
    `INSERT INTO host_metrics
       (ts, cpu_percent, mem_used_bytes, mem_total_bytes,
        disk_used_bytes, disk_total_bytes, load1, load5, load15, cpu_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0.2, 0.3, ?)`,
  ).run(
    overrides.ts ?? 1_000,
    overrides.cpuPercent ?? 12.5,
    overrides.memUsed ?? 1_000,
    overrides.memTotal ?? 8_000,
    overrides.diskUsed ?? 5_000,
    overrides.diskTotal ?? 50_000,
    overrides.load1 ?? 0.1,
    overrides.cpuCount ?? 4,
  );
}

function insertContainer(
  db: ReturnType<typeof makeDb>,
  projectId: string,
  overrides: Partial<{
    ts: number;
    containerId: string;
    cpuPercent: number;
    memUsed: number;
    memLimit: number;
    restartCount: number;
    running: number;
  }> = {},
) {
  db.query(
    `INSERT INTO container_metrics
       (ts, project_id, container_id, cpu_percent, mem_used_bytes, mem_limit_bytes, restart_count, running)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.ts ?? 1_000,
    projectId,
    overrides.containerId ?? "abc123",
    overrides.cpuPercent ?? 3.5,
    overrides.memUsed ?? 500,
    overrides.memLimit ?? 2_000,
    overrides.restartCount ?? 0,
    overrides.running ?? 1,
  );
}

// ---------------------------------------------------------------------------

describe("host_metrics", () => {
  test("INSERT ปกติแล้วอ่านกลับได้ครบทุก column", () => {
    const db = makeDb();
    insertHost(db, { ts: 5_000, cpuPercent: 42.25, cpuCount: 8 });

    const row = db
      .query<{ ts: number; cpu_percent: number; cpu_count: number }, []>(
        "SELECT ts, cpu_percent, cpu_count FROM host_metrics",
      )
      .get();

    expect(row?.ts).toBe(5_000);
    expect(row?.cpu_percent).toBeCloseTo(42.25);
    expect(row?.cpu_count).toBe(8);
  });

  test("ts เป็น PRIMARY KEY — INSERT ซ้ำ ts เดิม throw", () => {
    const db = makeDb();
    insertHost(db, { ts: 1_000 });
    expect(() => insertHost(db, { ts: 1_000 })).toThrow();
  });

  test("INSERT OR REPLACE ทับ sample เดิมได้ (worker ซ้อนกันชั่วคราวไม่ทำข้อมูลซ้ำ)", () => {
    const db = makeDb();
    insertHost(db, { ts: 1_000, cpuPercent: 10 });
    db.query(
      `INSERT OR REPLACE INTO host_metrics
         (ts, cpu_percent, mem_used_bytes, mem_total_bytes,
          disk_used_bytes, disk_total_bytes, load1, load5, load15, cpu_count)
       VALUES (1000, 99, 1, 2, 1, 2, 0, 0, 0, 1)`,
    ).run();

    const rows = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM host_metrics").get();
    const cpu = db.query<{ cpu_percent: number }, []>("SELECT cpu_percent FROM host_metrics").get();
    expect(rows?.c).toBe(1);
    expect(cpu?.cpu_percent).toBe(99);
  });

  test("cpu_percent ติดลบถูกปฏิเสธ", () => {
    const db = makeDb();
    expect(() => insertHost(db, { cpuPercent: -1 })).toThrow();
  });

  test("mem_total_bytes ต้อง > 0 (กันหารศูนย์ตอนคำนวณ %)", () => {
    const db = makeDb();
    expect(() => insertHost(db, { memTotal: 0 })).toThrow();
  });

  test("disk_total_bytes ต้อง > 0", () => {
    const db = makeDb();
    expect(() => insertHost(db, { diskTotal: 0 })).toThrow();
  });

  test("cpu_count ต้อง > 0 (ใช้หารตอนแปล load average)", () => {
    const db = makeDb();
    expect(() => insertHost(db, { cpuCount: 0 })).toThrow();
  });

  test("prune ตามช่วงเวลาลบเฉพาะแถวที่เก่ากว่า cutoff", () => {
    const db = makeDb();
    insertHost(db, { ts: 1_000 });
    insertHost(db, { ts: 2_000 });
    insertHost(db, { ts: 3_000 });

    db.query("DELETE FROM host_metrics WHERE ts < ?").run(2_500);

    const remaining = db
      .query<{ ts: number }, []>("SELECT ts FROM host_metrics ORDER BY ts")
      .all()
      .map((r) => r.ts);
    expect(remaining).toEqual([3_000]);
  });
});

describe("container_metrics", () => {
  test("INSERT ปกติแล้วอ่านกลับได้", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertContainer(db, projectId, { ts: 7_000, containerId: "deadbeef", cpuPercent: 55.5 });

    const row = db
      .query<{ container_id: string; cpu_percent: number; running: number }, []>(
        "SELECT container_id, cpu_percent, running FROM container_metrics",
      )
      .get();

    expect(row?.container_id).toBe("deadbeef");
    expect(row?.cpu_percent).toBeCloseTo(55.5);
    expect(row?.running).toBe(1);
  });

  test("PRIMARY KEY (project_id, ts) — project เดิม ts เดิม ซ้ำไม่ได้", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertContainer(db, projectId, { ts: 1_000 });
    expect(() => insertContainer(db, projectId, { ts: 1_000 })).toThrow();
  });

  test("คนละ project ใช้ ts เดียวกันได้ (เก็บพร้อมกันในรอบเดียว)", () => {
    const db = makeDb();
    const a = insertProject(db, "01JTEST0000000000000PROJECTA");
    const b = insertProject(db, "01JTEST0000000000000PROJECTB");

    insertContainer(db, a, { ts: 1_000 });
    insertContainer(db, b, { ts: 1_000 });

    const count = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM container_metrics").get();
    expect(count?.c).toBe(2);
  });

  test("mem_limit_bytes = 0 ได้ (container ที่ไม่ได้จำกัด memory)", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertContainer(db, projectId, { memLimit: 0 });

    const row = db
      .query<{ mem_limit_bytes: number }, []>("SELECT mem_limit_bytes FROM container_metrics")
      .get();
    expect(row?.mem_limit_bytes).toBe(0);
  });

  test("running รับเฉพาะ 0/1", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    expect(() => insertContainer(db, projectId, { running: 2 })).toThrow();
  });

  test("restart_count ติดลบถูกปฏิเสธ", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    expect(() => insertContainer(db, projectId, { restartCount: -1 })).toThrow();
  });

  test("ลบ project แล้ว metrics ถูก CASCADE ตาม", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertContainer(db, projectId, { ts: 1_000 });
    insertContainer(db, projectId, { ts: 2_000 });

    db.query("DELETE FROM projects WHERE id = ?").run(projectId);

    const count = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM container_metrics").get();
    expect(count?.c).toBe(0);
  });

  test("FK บังคับ — project_id ที่ไม่มีจริงถูกปฏิเสธ", () => {
    const db = makeDb();
    expect(() => insertContainer(db, "01JNOSUCHPROJECT000000000000")).toThrow();
  });

  test("index idx_container_metrics_ts มีอยู่จริง (prune ข้าม project พึ่ง index นี้)", () => {
    const db = makeDb();
    const idx = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_container_metrics_ts'",
      )
      .get();
    expect(idx?.name).toBe("idx_container_metrics_ts");
  });

  test("prune ข้าม project ลบทุกแถวที่เก่ากว่า cutoff", () => {
    const db = makeDb();
    const a = insertProject(db, "01JTEST0000000000000PROJECTA");
    const b = insertProject(db, "01JTEST0000000000000PROJECTB");
    insertContainer(db, a, { ts: 1_000 });
    insertContainer(db, a, { ts: 9_000 });
    insertContainer(db, b, { ts: 1_000 });

    db.query("DELETE FROM container_metrics WHERE ts < ?").run(5_000);

    const rows = db
      .query<{ project_id: string; ts: number }, []>(
        "SELECT project_id, ts FROM container_metrics ORDER BY ts",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ts).toBe(9_000);
    expect(rows[0]?.project_id).toBe(a);
  });
});
