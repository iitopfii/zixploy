/**
 * runBackup/runRestore — unit tests (Phase 16)
 *
 * mock DockerCliClient เต็มรูปแบบ (ไม่ต้องมี Docker จริง) — spawnCaptureToFile/spawnFromFile
 * ของ mock เขียน/อ่านไฟล์จริงบนดิสก์ชั่วคราว เพื่อให้ path ของโค้ดจริง (statSync, ลบไฟล์, ฯลฯ)
 * ทำงานได้เหมือนของจริงโดยไม่ต้องพึ่ง Docker
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { serviceContainerName, ulid } from "@zixploy/shared";
import type { DockerCliClient } from "../src/docker/cli-client";
import { runBackup, runRestore } from "../src/services/backup";

const backupsRoot = mkdtempSync(join(tmpdir(), "zixploy-service-backup-test-"));
afterEach(() => {
  try {
    rmSync(backupsRoot, { recursive: true, force: true });
  } catch {
    // Windows อาจปล่อย handle ช้า — ปล่อยให้ OS เก็บกวาด
  }
});

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function insertService(
  db: ReturnType<typeof makeDb>,
  opts: {
    type?: string;
    retention?: number;
  } = {},
): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO services
      (id, name, type, version, image, status, container_id, volume_name,
       username, database_name, internal_port, backup_retention_count, created_at, updated_at)
     VALUES (?, ?, ?, '16', 'postgres:16', 'running', ?, ?, 'app', 'app', 5432, ?, ?, ?)`,
  ).run(
    id,
    `db-${id.toLowerCase()}`,
    opts.type ?? "postgres",
    serviceContainerName(id),
    `zxsvcvol-${id.toLowerCase()}`,
    opts.retention ?? 7,
    now,
    now,
  );
  return id;
}

function insertBackup(
  db: ReturnType<typeof makeDb>,
  serviceId: string,
  opts: { status?: string; fileName?: string | null; createdAt?: number } = {},
): string {
  const id = ulid();
  const now = opts.createdAt ?? Date.now();
  db.query(
    `INSERT INTO service_backups (id, service_id, trigger, status, file_name, started_at, finished_at, created_at)
     VALUES (?, ?, 'manual', ?, ?, ?, ?, ?)`,
  ).run(id, serviceId, opts.status ?? "succeeded", opts.fileName ?? `${id}.sql`, now, now, now);
  return id;
}

function countBackups(db: ReturnType<typeof makeDb>, serviceId: string): number {
  return db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) as n FROM service_backups WHERE service_id = ?",
    )
    .get(serviceId)!.n;
}

/** mock DockerCliClient — spawnCaptureToFile เขียนไฟล์ปลอมจริงลงดิสก์ ให้ statSync ใน backup.ts ทำงานได้ */
function mockDocker(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, impl: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return impl(...args);
    };

  const docker = {
    calls,
    inspectContainer: record("inspectContainer", async () => ({
      Id: "container-1",
      Name: "/test",
      State: { Status: "running", Running: true },
    })),
    stopContainer: record("stopContainer", async () => undefined),
    startContainer: record("startContainer", async () => undefined),
    pullImage: record("pullImage", async () => undefined),
    spawnCaptureToFile: record("spawnCaptureToFile", async (_args: unknown, destPath: unknown) => {
      writeFileSync(destPath as string, "-- fake dump content --\n");
      return { code: 0, stderr: "" };
    }),
    spawnFromFile: record("spawnFromFile", async () => ({ code: 0, stderr: "" })),
    ...overrides,
  };
  return docker;
}

// ---------------------------------------------------------------------------

describe("runBackup — exec mode (postgres)", () => {
  test("สำเร็จ: เขียนไฟล์, บันทึก service_backups succeeded, อัป last_backup_at", async () => {
    const db = makeDb();
    const serviceId = insertService(db);
    const docker = mockDocker();

    await runBackup(
      { db, docker: docker as unknown as DockerCliClient, backupsDir: backupsRoot },
      serviceId,
      "manual",
    );

    const row = db
      .query<{ status: string; file_name: string | null; size_bytes: number | null }, [string]>(
        "SELECT status, file_name, size_bytes FROM service_backups WHERE service_id = ?",
      )
      .get(serviceId);
    expect(row?.status).toBe("succeeded");
    expect(row?.file_name).toEndWith(".sql");
    expect(row?.size_bytes).toBeGreaterThan(0);

    const svc = db
      .query<{ last_backup_at: number | null }, [string]>(
        "SELECT last_backup_at FROM services WHERE id = ?",
      )
      .get(serviceId);
    expect(svc?.last_backup_at).not.toBeNull();

    // exec ผ่าน docker exec -i <container> <dumpCmd...> — ไม่ใช่ stop/start (ไม่มี downtime)
    const execCall = docker.calls.find((c) => c.method === "spawnCaptureToFile");
    const args = execCall?.args[0] as string[];
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("-i");
    expect(docker.calls.some((c) => c.method === "stopContainer")).toBe(false);
  });

  test("container ไม่ได้รันอยู่ → ล้มเหลวทันทีโดยไม่พยายาม exec", async () => {
    const db = makeDb();
    const serviceId = insertService(db);
    const docker = mockDocker({
      inspectContainer: async () => ({ Id: "c1", Name: "/x", State: { Running: false } }),
    });

    await expect(
      runBackup(
        { db, docker: docker as unknown as DockerCliClient, backupsDir: backupsRoot },
        serviceId,
        "manual",
      ),
    ).rejects.toThrow();

    const row = db
      .query<{ status: string; failure_message: string | null }, [string]>(
        "SELECT status, failure_message FROM service_backups WHERE service_id = ?",
      )
      .get(serviceId);
    expect(row?.status).toBe("failed");
    expect(row?.failure_message).toContain("ไม่ได้รันอยู่");
  });

  test("dump command ล้มเหลว (exit code != 0) → บันทึก failed พร้อมข้อความจาก stderr", async () => {
    const db = makeDb();
    const serviceId = insertService(db);
    const docker = mockDocker({
      spawnCaptureToFile: async () => ({ code: 1, stderr: "pg_dump: connection refused" }),
    });

    await expect(
      runBackup(
        { db, docker: docker as unknown as DockerCliClient, backupsDir: backupsRoot },
        serviceId,
        "manual",
      ),
    ).rejects.toThrow(/connection refused/);

    const row = db
      .query<{ status: string }, [string]>(
        "SELECT status FROM service_backups WHERE service_id = ?",
      )
      .get(serviceId);
    expect(row?.status).toBe("failed");
  });

  test("retention: เกิน backup_retention_count → ลบตัวเก่าสุดทั้งแถวและไฟล์", async () => {
    const db = makeDb();
    const serviceId = insertService(db, { retention: 2 });
    const docker = mockDocker();

    // ทำ backup สำเร็จ 3 ครั้งติดกัน — เก็บได้แค่ 2 ตามที่ตั้งไว้
    for (let i = 0; i < 3; i++) {
      await runBackup(
        { db, docker: docker as unknown as DockerCliClient, backupsDir: backupsRoot },
        serviceId,
        "manual",
      );
    }

    expect(countBackups(db, serviceId)).toBe(2);
  });
});

describe("runBackup — file-copy mode (redis)", () => {
  test("หยุด container ก่อน tar แล้วเริ่มใหม่หลังเสร็จ", async () => {
    const db = makeDb();
    const serviceId = insertService(db, { type: "redis" });
    const docker = mockDocker();

    await runBackup(
      { db, docker: docker as unknown as DockerCliClient, backupsDir: backupsRoot },
      serviceId,
      "manual",
    );

    const methods = docker.calls.map((c) => c.method);
    const stopIdx = methods.indexOf("stopContainer");
    const tarIdx = methods.indexOf("spawnCaptureToFile");
    const startIdx = methods.indexOf("startContainer");
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(tarIdx);
    expect(tarIdx).toBeGreaterThan(stopIdx);

    const row = db
      .query<{ file_name: string | null }, [string]>(
        "SELECT file_name FROM service_backups WHERE service_id = ?",
      )
      .get(serviceId);
    expect(row?.file_name).toEndWith(".tar.gz");
  });

  test("container ไม่ได้รันอยู่แล้ว (stopped) → ไม่เรียก start ตามหลัง", async () => {
    const db = makeDb();
    const serviceId = insertService(db, { type: "redis" });
    const docker = mockDocker({
      inspectContainer: async () => ({ Id: "c1", Name: "/x", State: { Running: false } }),
    });

    await runBackup(
      { db, docker: docker as unknown as DockerCliClient, backupsDir: backupsRoot },
      serviceId,
      "manual",
    );

    expect(docker.calls.some((c) => c.method === "stopContainer")).toBe(false);
    expect(docker.calls.some((c) => c.method === "startContainer")).toBe(false);
  });

  test("tar ล้มเหลว → ยัง start container กลับคืน (finally)", async () => {
    const db = makeDb();
    const serviceId = insertService(db, { type: "redis" });
    const docker = mockDocker({
      spawnCaptureToFile: async () => ({ code: 1, stderr: "tar: short write" }),
    });

    await expect(
      runBackup(
        { db, docker: docker as unknown as DockerCliClient, backupsDir: backupsRoot },
        serviceId,
        "manual",
      ),
    ).rejects.toThrow();

    expect(docker.calls.some((c) => c.method === "startContainer")).toBe(true);
  });
});

describe("runRestore", () => {
  test("exec mode: อ่าน backup ไฟล์เป็น stdin ผ่าน docker exec", async () => {
    const db = makeDb();
    const serviceId = insertService(db);
    const dir = join(backupsRoot, "services", serviceId);
    mkdirSync(dir, { recursive: true });
    const backupId = insertBackup(db, serviceId, { fileName: "abc.sql" });
    writeFileSync(join(dir, "abc.sql"), "INSERT INTO x VALUES (1);\n");

    const docker = mockDocker();
    await runRestore(
      { db, docker: docker as unknown as DockerCliClient, backupsDir: backupsRoot },
      serviceId,
      backupId,
    );

    const call = docker.calls.find((c) => c.method === "spawnFromFile");
    expect(call).toBeDefined();
    const args = call?.args[0] as string[];
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("-i");
    const srcPath = call?.args[1] as string;
    expect(readFileSync(srcPath, "utf8")).toContain("INSERT INTO x");
  });

  test("backup ไม่มีอยู่จริง → throw SERVICE_BACKUP_NOT_FOUND", async () => {
    const db = makeDb();
    const serviceId = insertService(db);
    const docker = mockDocker();

    await expect(
      runRestore(
        { db, docker: docker as unknown as DockerCliClient, backupsDir: backupsRoot },
        serviceId,
        ulid(),
      ),
    ).rejects.toThrow();
  });

  test("backup ยังไม่ succeeded (กำลัง running) → throw SERVICE_BACKUP_NOT_READY", async () => {
    const db = makeDb();
    const serviceId = insertService(db);
    const backupId = insertBackup(db, serviceId, { status: "running", fileName: null });
    const docker = mockDocker();

    await expect(
      runRestore(
        { db, docker: docker as unknown as DockerCliClient, backupsDir: backupsRoot },
        serviceId,
        backupId,
      ),
    ).rejects.toThrow();
  });

  test("backup succeeded แต่ไฟล์หายจากดิสก์ → throw SERVICE_BACKUP_NOT_FOUND", async () => {
    const db = makeDb();
    const serviceId = insertService(db);
    const backupId = insertBackup(db, serviceId, { fileName: "gone.sql" });
    const docker = mockDocker();

    await expect(
      runRestore(
        { db, docker: docker as unknown as DockerCliClient, backupsDir: backupsRoot },
        serviceId,
        backupId,
      ),
    ).rejects.toThrow();
  });

  test("file-copy mode (redis): หยุด → extract → เริ่มใหม่", async () => {
    const db = makeDb();
    const serviceId = insertService(db, { type: "redis" });
    const dir = join(backupsRoot, "services", serviceId);
    mkdirSync(dir, { recursive: true });
    const backupId = insertBackup(db, serviceId, { fileName: "snap.tar.gz" });
    writeFileSync(join(dir, "snap.tar.gz"), "fake-tar-bytes");

    const docker = mockDocker();
    await runRestore(
      { db, docker: docker as unknown as DockerCliClient, backupsDir: backupsRoot },
      serviceId,
      backupId,
    );

    const methods = docker.calls.map((c) => c.method);
    expect(methods.indexOf("stopContainer")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("startContainer")).toBeGreaterThan(methods.indexOf("spawnFromFile"));
  });
});
