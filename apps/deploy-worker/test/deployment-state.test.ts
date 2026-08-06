/**
 * db/deployment-state.ts — unit tests สำหรับ transition helper โดยตรง (ไม่ผ่าน pipeline)
 */
import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import {
  cancelDeploymentRecord,
  failDeployment,
  getDeploymentStatus,
  transitionDeployment,
  transitionToStartingForRollback,
} from "../src/db/deployment-state";

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function insertProject(db: ReturnType<typeof openDatabase>) {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO projects (id, name, status, dockerfile_path, build_context, created_at, updated_at)
     VALUES (?, 'p', 'new', 'Dockerfile', '.', ?, ?)`,
  ).run(id, now, now);
  return id;
}

function insertDeployment(
  db: ReturnType<typeof openDatabase>,
  projectId: string,
  status = "queued",
) {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
     VALUES (?, ?, ?, 'manual', ?, ?, ?, ?)`,
  ).run(id, projectId, status, "a".repeat(40), now, now, now);
  return id;
}

describe("transitionDeployment", () => {
  test("queued → cloning: ตั้ง started_at และ cloning_at", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId, "queued");

    transitionDeployment(db, deploymentId, "cloning");

    const row = db
      .query<{ status: string; started_at: number | null; cloning_at: number | null }, [string]>(
        "SELECT status, started_at, cloning_at FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(row?.status).toBe("cloning");
    expect(row?.started_at).not.toBeNull();
    expect(row?.cloning_at).not.toBeNull();
  });

  test("started_at ตั้งครั้งเดียวตอนออกจาก queued — ไม่ถูกเขียนทับที่ transition ถัดไป", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId, "queued");

    transitionDeployment(db, deploymentId, "cloning");
    const afterFirst = db
      .query<{ started_at: number }, [string]>("SELECT started_at FROM deployments WHERE id = ?")
      .get(deploymentId);

    transitionDeployment(db, deploymentId, "building");
    const afterSecond = db
      .query<{ started_at: number }, [string]>("SELECT started_at FROM deployments WHERE id = ?")
      .get(deploymentId);

    expect(afterSecond?.started_at).toBe(afterFirst?.started_at ?? -1);
  });

  test("transition ผิดกติกา (เช่น queued → building ตรงๆ) → throw", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId, "queued");

    expect(() => transitionDeployment(db, deploymentId, "building")).toThrow();
  });

  test("succeeded ตั้ง finished_at", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId, "activating");

    transitionDeployment(db, deploymentId, "succeeded");

    const row = db
      .query<{ status: string; finished_at: number | null }, [string]>(
        "SELECT status, finished_at FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(row?.status).toBe("succeeded");
    expect(row?.finished_at).not.toBeNull();
  });

  test("extra fields (imageTag/imageDigest/containerId) เขียนลง DB ถูกต้อง", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId, "building");

    transitionDeployment(db, deploymentId, "starting", {
      imageTag: "zixploy/x:tag",
      imageDigest: "sha256:abc",
    });

    const row = db
      .query<{ image_tag: string | null; image_digest: string | null }, [string]>(
        "SELECT image_tag, image_digest FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(row?.image_tag).toBe("zixploy/x:tag");
    expect(row?.image_digest).toBe("sha256:abc");
  });
});

describe("failDeployment", () => {
  test("mark failed พร้อม failure_code/message และ finished_at", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId, "building");

    failDeployment(db, deploymentId, "BUILD_FAILED", "exit code 1");

    const row = db
      .query<
        {
          status: string;
          failure_code: string | null;
          failure_message: string | null;
          finished_at: number | null;
        },
        [string]
      >("SELECT status, failure_code, failure_message, finished_at FROM deployments WHERE id = ?")
      .get(deploymentId);
    expect(row?.status).toBe("failed");
    expect(row?.failure_code).toBe("BUILD_FAILED");
    expect(row?.failure_message).toBe("exit code 1");
    expect(row?.finished_at).not.toBeNull();
  });

  test("เรียกซ้ำบน terminal state ที่ mark ไปแล้ว → throw (กัน double-fail)", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId, "building");

    failDeployment(db, deploymentId, "BUILD_FAILED", "first");
    expect(() => failDeployment(db, deploymentId, "BUILD_FAILED", "second")).toThrow();
  });
});

describe("cancelDeploymentRecord", () => {
  test("mark cancelled จาก non-terminal state", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId, "cloning");

    cancelDeploymentRecord(db, deploymentId);

    const status = getDeploymentStatus(db, deploymentId);
    expect(status).toBe("cancelled");
  });
});

describe("getDeploymentStatus", () => {
  test("deployment ไม่พบ → null (ไม่ throw)", () => {
    const db = makeDb();
    expect(getDeploymentStatus(db, "01JNOTFOUND0000000000000000")).toBeNull();
  });

  test("deployment พบ → คืน status ปัจจุบัน", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId, "building");
    expect(getDeploymentStatus(db, deploymentId)).toBe("building");
  });
});

describe("transitionToStartingForRollback — ข้อยกเว้นเฉพาะ rollback", () => {
  test("queued → starting โดยตรง: cloning_at/building_at ยังเป็น null", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId, "queued");

    transitionToStartingForRollback(db, deploymentId);

    const row = db
      .query<
        {
          status: string;
          cloning_at: number | null;
          building_at: number | null;
          starting_at: number | null;
          started_at: number | null;
        },
        [string]
      >(
        "SELECT status, cloning_at, building_at, starting_at, started_at FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(row?.status).toBe("starting");
    expect(row?.cloning_at).toBeNull();
    expect(row?.building_at).toBeNull();
    expect(row?.starting_at).not.toBeNull();
    expect(row?.started_at).not.toBeNull();
  });

  test("จาก status อื่นที่ไม่ใช่ queued → throw (precondition check ของตัวเอง)", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, projectId, "cloning");

    expect(() => transitionToStartingForRollback(db, deploymentId)).toThrow(/queued/);
  });
});
