/**
 * Volume reconciler tests — Phase 7 M5
 *
 * ครอบคลุม:
 * - deletion_pending → docker volume rm สำเร็จ → lifecycle='deleted'
 * - deletion_pending → docker volume rm ล้มเหลว (in-use) → lifecycle ยังเป็น deletion_pending
 * - active volume ที่ Docker volume ไม่มีอยู่ → lifecycle='error'
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

function insertVolume(db: ReturnType<typeof makeDb>, projectId: string, lifecycle: string): string {
  const id = ulid();
  const dockerName = volumeName(projectId, id);
  db.query(
    `INSERT INTO volumes
       (id, project_id, display_name, docker_name, mount_path, access_mode, driver,
        driver_opts, read_only, lifecycle, created_at, updated_at)
     VALUES (?, ?, 'vol', ?, '/data', 'shared-safe', 'local', '{}', 0, ?, 1, 1)`,
  ).run(id, projectId, dockerName, lifecycle);
  return id;
}

function getLifecycle(db: ReturnType<typeof makeDb>, volumeId: string): string {
  return db
    .query<{ lifecycle: string }, [string]>("SELECT lifecycle FROM volumes WHERE id = ?")
    .get(volumeId)!.lifecycle;
}

function makeMockDocker(opts: {
  removeVolume?: (name: string) => Promise<void>;
  inspectVolume?: (name: string) => Promise<unknown>;
}) {
  return {
    removeVolume: opts.removeVolume ?? (async (_name: string) => {}),
    inspectVolume: opts.inspectVolume ?? (async (_name: string): Promise<unknown> => null),
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

  test("docker volume rm ล้มเหลว (in-use) → lifecycle ยังเป็น deletion_pending", async () => {
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
    expect(getLifecycle(db, volumeId)).toBe("deletion_pending");
  });
});

// ---------------------------------------------------------------------------
// active → error (orphan)
// ---------------------------------------------------------------------------

describe("reconciler: orphan detection", () => {
  test("active volume ที่ Docker volume ไม่มีอยู่ → lifecycle='error'", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const volumeId = insertVolume(db, projectId, "active");

    const ctrl = new AbortController();
    const docker = makeMockDocker({
      inspectVolume: async () => {
        ctrl.abort();
        return null; // Docker volume ไม่มีอยู่
      },
    });

    await volumeReconcileLoop(
      db,
      docker as unknown as Parameters<typeof volumeReconcileLoop>[1],
      ctrl.signal,
    );

    expect(getLifecycle(db, volumeId)).toBe("error");
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

  test("detached volume orphan → lifecycle='error'", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const volumeId = insertVolume(db, projectId, "detached");

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
    const volumeId = insertVolume(db, projectId, "error");

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
