/**
 * Volume reconciler tests — Phase 7 M5
 *
 * ครอบคลุม:
 * - deletion_pending → docker volume rm สำเร็จ → lifecycle='deleted'
 * - deletion_pending → docker volume rm ล้มเหลว (in-use) → คงสถานะ + last_error บอกสาเหตุ
 * - never-attached volume ที่ Docker volume ไม่มีอยู่ → auto-create ไม่ใช่ error
 *   (บทเรียน 2026-08-20: volume ที่เพิ่งสร้างใน UI ถูกตีตรา error ก่อน redeploy ทัน)
 * - error + never-attached → auto-heal กลับเป็น active
 * - orphan จริง (เคย attach แล้ว Docker volume หาย) → error + last_error ชี้ runbook
 * - active volume ที่ Docker volume มีอยู่จริง → lifecycle ไม่เปลี่ยน
 * - signal abort หยุด loop
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { AppError, ulid, volumeName } from "@zixploy/shared";
import { volumeReconcileLoop } from "../src/volumes/reconciler";

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function insertProject(db: ReturnType<typeof makeDb>): string {
  const id = ulid();
  db.query(
    `INSERT INTO projects
      (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'p', 'new', 'Dockerfile', '.', 'unless-stopped', 900, 1, 1)`,
  ).run(id);
  return id;
}

function insertVolume(
  db: ReturnType<typeof makeDb>,
  projectId: string,
  lifecycle: string,
  opts: { lastAttachedAt?: number; driverOpts?: Record<string, string> } = {},
): string {
  const id = ulid();
  const dockerName = volumeName(projectId, id);
  db.query(
    `INSERT INTO volumes
       (id, project_id, display_name, docker_name, mount_path, access_mode, driver,
        driver_opts, read_only, lifecycle, last_attached_at, created_at, updated_at)
     VALUES (?, ?, 'vol', ?, '/data', 'shared-safe', 'local', ?, 0, ?, ?, 1, 1)`,
  ).run(
    id,
    projectId,
    dockerName,
    JSON.stringify(opts.driverOpts ?? {}),
    lifecycle,
    opts.lastAttachedAt ?? null,
  );
  return id;
}

function getVolumeState(
  db: ReturnType<typeof makeDb>,
  volumeId: string,
): { lifecycle: string; last_error: string | null } {
  return db
    .query<{ lifecycle: string; last_error: string | null }, [string]>(
      "SELECT lifecycle, last_error FROM volumes WHERE id = ?",
    )
    .get(volumeId)!;
}

function getLifecycle(db: ReturnType<typeof makeDb>, volumeId: string): string {
  return getVolumeState(db, volumeId).lifecycle;
}

function makeMockDocker(opts: {
  removeVolume?: (name: string) => Promise<void>;
  inspectVolume?: (name: string) => Promise<unknown>;
  createVolume?: (params: {
    name: string;
    driver: string;
    labels?: Record<string, string>;
    opts?: Record<string, string>;
  }) => Promise<void>;
}) {
  return {
    removeVolume: opts.removeVolume ?? (async (_name: string) => {}),
    inspectVolume: opts.inspectVolume ?? (async (_name: string): Promise<unknown> => null),
    createVolume: opts.createVolume ?? (async () => {}),
  };
}

// ---------------------------------------------------------------------------
// deletion_pending → deleted
// ---------------------------------------------------------------------------

describe("reconciler: deletion_pending", () => {
  test("docker volume rm สำเร็จ → lifecycle='deleted'", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertVolume(db, projectId, "deletion_pending");

    const controller = new AbortController();
    const docker = makeMockDocker({ removeVolume: async () => {} });

    // รัน loop แล้ว abort ทันที
    controller.abort();
    await volumeReconcileLoop(
      db,
      docker as unknown as Parameters<typeof volumeReconcileLoop>[1],
      controller.signal,
    );

    // Loop หยุดก่อน reconcile (signal aborted ก่อนเริ่ม while) — เรียก reconcileOnce ตรงแทน
    // ดังนั้นเทสต์นี้ test ผ่าน reconcileOnce โดยตรงโดย inject signal ที่ยังไม่ abort

    // แนวทางที่ดีกว่า: ใช้ signal ที่ abort หลัง 1 ms
    const db2 = makeDb();
    const projectId2 = insertProject(db2);
    const volumeId2 = insertVolume(db2, projectId2, "deletion_pending");

    const ctrl2 = new AbortController();
    const rmCalls: string[] = [];
    const docker2 = makeMockDocker({
      removeVolume: async (name) => {
        rmCalls.push(name);
        ctrl2.abort(); // abort loop หลัง reconcile รอบแรก
      },
    });

    await volumeReconcileLoop(
      db2,
      docker2 as unknown as Parameters<typeof volumeReconcileLoop>[1],
      ctrl2.signal,
    );

    expect(rmCalls).toHaveLength(1);
    expect(getLifecycle(db2, volumeId2)).toBe("deleted");
  });

  test("docker volume rm ล้มเหลว (in-use) → คง deletion_pending + last_error บอกให้ redeploy", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const volumeId = insertVolume(db, projectId, "deletion_pending");

    const ctrl = new AbortController();
    let called = false;
    const docker = makeMockDocker({
      removeVolume: async () => {
        called = true;
        ctrl.abort();
        throw new AppError("VOLUME_IN_USE", "in-use");
      },
    });

    await volumeReconcileLoop(
      db,
      docker as unknown as Parameters<typeof volumeReconcileLoop>[1],
      ctrl.signal,
    );

    expect(called).toBe(true);
    // lifecycle ต้องยังเป็น deletion_pending (ไม่ถูกอัปเดตถ้า rm fail)
    const state = getVolumeState(db, volumeId);
    expect(state.lifecycle).toBe("deletion_pending");
    // สาเหตุต้องถูกเขียนให้ user เห็น — เดิมค้าง "รอ worker ลบ…" โดยไม่รู้ว่าติด in-use
    expect(state.last_error).toContain("redeploy");
    expect(state.last_error).toContain("container");
  });

  test("docker volume rm ล้มเหลวด้วยเหตุอื่น → คง deletion_pending + last_error = ข้อความ error (ตัดสั้น)", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const volumeId = insertVolume(db, projectId, "deletion_pending");

    const ctrl = new AbortController();
    const longMessage = "docker daemon ล่ม: ".repeat(50); // ยาวเกิน 200 ตัวอักษร
    const docker = makeMockDocker({
      removeVolume: async () => {
        ctrl.abort();
        throw new AppError("DOCKER_UNAVAILABLE", longMessage);
      },
    });

    await volumeReconcileLoop(
      db,
      docker as unknown as Parameters<typeof volumeReconcileLoop>[1],
      ctrl.signal,
    );

    const state = getVolumeState(db, volumeId);
    expect(state.lifecycle).toBe("deletion_pending");
    expect(state.last_error).toContain("docker daemon");
    expect(state.last_error!.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// never-attached + Docker volume ไม่มีอยู่ → auto-create (ไม่ใช่ orphan)
// ---------------------------------------------------------------------------

describe("reconciler: auto-create never-attached volume", () => {
  test("active + ไม่เคย attach + Docker volume ไม่มี → createVolume ถูกเรียก, lifecycle คงเดิม", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const volumeId = insertVolume(db, projectId, "active"); // last_attached_at = NULL

    const ctrl = new AbortController();
    const createCalls: { name: string; driver: string; labels?: Record<string, string> }[] = [];
    const docker = makeMockDocker({
      inspectVolume: async () => {
        ctrl.abort();
        return null; // Docker volume ยังไม่ถูกสร้าง (ยังไม่เคย deploy)
      },
      createVolume: async (params) => {
        createCalls.push(params);
      },
    });

    await volumeReconcileLoop(
      db,
      docker as unknown as Parameters<typeof volumeReconcileLoop>[1],
      ctrl.signal,
    );

    // ต้องสร้างด้วย labels ชุดเดียวกับ pipeline (platform.managed / platform.volume_id)
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.driver).toBe("local");
    expect(createCalls[0]!.labels).toEqual({
      "platform.managed": "true",
      "platform.volume_id": volumeId,
    });

    const state = getVolumeState(db, volumeId);
    expect(state.lifecycle).toBe("active"); // ไม่ถูกตีตรา error
    expect(state.last_error).toBeNull();
  });

  test("bind volume (driver_opts) → auto-create ส่ง opts เข้า docker.createVolume ด้วย", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const bindOpts = { type: "none", o: "bind", device: "/home/cwie-db" };
    insertVolume(db, projectId, "active", { driverOpts: bindOpts });

    const ctrl = new AbortController();
    const createCalls: { opts?: Record<string, string> }[] = [];
    const docker = makeMockDocker({
      inspectVolume: async () => {
        ctrl.abort();
        return null;
      },
      createVolume: async (params) => {
        createCalls.push(params);
      },
    });

    await volumeReconcileLoop(
      db,
      docker as unknown as Parameters<typeof volumeReconcileLoop>[1],
      ctrl.signal,
    );

    // ไม่ส่ง opts = bind volume ถูกสร้างผิดเป็น volume เปล่า (ต้นเหตุที่ต้องแก้ในงานนี้)
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.opts).toEqual(bindOpts);
  });

  test("named volume ปกติ → auto-create ไม่ส่ง opts (call เดิม)", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertVolume(db, projectId, "active");

    const ctrl = new AbortController();
    const createCalls: { opts?: Record<string, string> }[] = [];
    const docker = makeMockDocker({
      inspectVolume: async () => {
        ctrl.abort();
        return null;
      },
      createVolume: async (params) => {
        createCalls.push(params);
      },
    });

    await volumeReconcileLoop(
      db,
      docker as unknown as Parameters<typeof volumeReconcileLoop>[1],
      ctrl.signal,
    );

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.opts).toBeUndefined();
  });

  test("error + ไม่เคย attach + Docker volume ไม่มี → auto-heal กลับเป็น active + ล้าง last_error", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    // จำลอง false positive จากเวอร์ชันก่อน: ถูกตีตรา error ทั้งที่ยังไม่เคย deploy
    const volumeId = insertVolume(db, projectId, "error");
    db.query("UPDATE volumes SET last_error = 'stale error' WHERE id = ?").run(volumeId);

    const ctrl = new AbortController();
    let created = false;
    const docker = makeMockDocker({
      inspectVolume: async () => {
        ctrl.abort();
        return null;
      },
      createVolume: async () => {
        created = true;
      },
    });

    await volumeReconcileLoop(
      db,
      docker as unknown as Parameters<typeof volumeReconcileLoop>[1],
      ctrl.signal,
    );

    expect(created).toBe(true);
    const state = getVolumeState(db, volumeId);
    expect(state.lifecycle).toBe("active");
    expect(state.last_error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// orphan จริง (เคย attach แล้ว Docker volume หาย) → error
// ---------------------------------------------------------------------------

describe("reconciler: orphan detection", () => {
  test("active volume ที่เคย attach แล้ว Docker volume ไม่มีอยู่ → lifecycle='error' + last_error ชี้ runbook", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const volumeId = insertVolume(db, projectId, "active", { lastAttachedAt: Date.now() });

    const ctrl = new AbortController();
    const docker = makeMockDocker({
      inspectVolume: async () => {
        ctrl.abort();
        return null; // Docker volume ไม่มีอยู่ทั้งที่เคยถูกใช้งาน
      },
    });

    await volumeReconcileLoop(
      db,
      docker as unknown as Parameters<typeof volumeReconcileLoop>[1],
      ctrl.signal,
    );

    const state = getVolumeState(db, volumeId);
    expect(state.lifecycle).toBe("error");
    expect(state.last_error).toContain("docs/runbooks/volume-backup-restore.md");
  });

  test("active volume ที่ Docker volume มีอยู่จริง → lifecycle ไม่เปลี่ยน", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const volumeId = insertVolume(db, projectId, "active");

    const ctrl = new AbortController();
    const docker = makeMockDocker({
      inspectVolume: async () => {
        ctrl.abort();
        return {
          Name: "zxvol-x",
          Driver: "local",
          Mountpoint: "/var/lib/docker/volumes/x",
          Labels: {},
        };
      },
    });

    await volumeReconcileLoop(
      db,
      docker as unknown as Parameters<typeof volumeReconcileLoop>[1],
      ctrl.signal,
    );

    expect(getLifecycle(db, volumeId)).toBe("active");
  });

  test("detached volume ที่เคย attach แล้วหาย → lifecycle='error'", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const volumeId = insertVolume(db, projectId, "detached", { lastAttachedAt: Date.now() });

    const ctrl = new AbortController();
    const docker = makeMockDocker({
      inspectVolume: async () => {
        ctrl.abort();
        return null;
      },
    });

    await volumeReconcileLoop(
      db,
      docker as unknown as Parameters<typeof volumeReconcileLoop>[1],
      ctrl.signal,
    );

    expect(getLifecycle(db, volumeId)).toBe("error");
  });

  test("volume error ที่ Docker volume มีอยู่แล้ว → lifecycle ยังเป็น error (ต้อง manual recovery)", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const volumeId = insertVolume(db, projectId, "error", { lastAttachedAt: Date.now() });

    const ctrl = new AbortController();
    const docker = makeMockDocker({
      inspectVolume: async () => {
        ctrl.abort();
        // Docker volume กลับมามีอยู่ แต่ lifecycle ไม่ auto-recover
        return {
          Name: "zxvol-x",
          Driver: "local",
          Mountpoint: "/var/lib/docker/volumes/x",
          Labels: {},
        };
      },
    });

    await volumeReconcileLoop(
      db,
      docker as unknown as Parameters<typeof volumeReconcileLoop>[1],
      ctrl.signal,
    );

    // lifecycle ต้องยังเป็น 'error' — ต้องการ explicit admin action
    expect(getLifecycle(db, volumeId)).toBe("error");
  });
});
