import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { AppError, ulid } from "@zixploy/shared";
import {
  cancelDeployment,
  enqueueManualJob,
  enqueueOperation,
  enqueuePushDeploy,
} from "../src/deploys/queue";

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function insertProject(db: ReturnType<typeof openDatabase>, id = ulid()) {
  const now = Date.now();
  db.query(
    `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'test', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(id, now, now);
  return id;
}

function insertSucceededDeployment(
  db: ReturnType<typeof openDatabase>,
  projectId: string,
  opts: { imageTag?: string; imageDigest?: string } = {},
) {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO deployments
      (id, project_id, status, trigger, commit_sha, image_tag, image_digest, queued_at, finished_at, created_at, updated_at)
     VALUES (?, ?, 'succeeded', 'push', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    "a".repeat(40),
    opts.imageTag ?? "zixploy/proj:abc123-dep1",
    opts.imageDigest ?? "sha256:" + "f".repeat(64),
    now,
    now,
    now,
    now,
  );
  return id;
}

describe("enqueuePushDeploy", () => {
  test("ไม่มี pending job → สร้าง deployment(queued) + deploy_job(pending) ใหม่", () => {
    const db = makeDb();
    const projectId = insertProject(db);

    const { deploymentId, coalesced } = enqueuePushDeploy(db, {
      projectId,
      installationId: 111,
      repoFullName: "org/repo",
      commitSha: "a".repeat(40),
      commitMessage: "first commit",
      commitAuthor: "Dev",
    });

    expect(coalesced).toBe(false);

    const deployment = db
      .query<{ status: string; trigger: string; commit_sha: string }, [string]>(
        "SELECT status, trigger, commit_sha FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(deployment?.status).toBe("queued");
    expect(deployment?.trigger).toBe("push");
    expect(deployment?.commit_sha).toBe("a".repeat(40));

    const job = db
      .query<{ status: string; type: string; priority: number }, [string]>(
        "SELECT status, type, priority FROM deploy_jobs WHERE deployment_id = ?",
      )
      .get(deploymentId);
    expect(job?.status).toBe("pending");
    expect(job?.type).toBe("deploy");
    expect(job?.priority).toBe(0);
  });

  test("มี pending job อยู่แล้ว → coalesce เข้า job เดิม ไม่สร้าง deployment ใหม่", () => {
    const db = makeDb();
    const projectId = insertProject(db);

    const first = enqueuePushDeploy(db, {
      projectId,
      installationId: 111,
      repoFullName: "org/repo",
      commitSha: "a".repeat(40),
      commitMessage: "first",
      commitAuthor: "Dev",
    });

    const second = enqueuePushDeploy(db, {
      projectId,
      installationId: 111,
      repoFullName: "org/repo",
      commitSha: "b".repeat(40),
      commitMessage: "second (latest)",
      commitAuthor: "Dev2",
    });

    expect(second.coalesced).toBe(true);
    expect(second.deploymentId).toBe(first.deploymentId);

    // deployment เดิมถูกอัปเดตเป็น commit ล่าสุด
    const deployment = db
      .query<{ commit_sha: string; commit_message: string }, [string]>(
        "SELECT commit_sha, commit_message FROM deployments WHERE id = ?",
      )
      .get(first.deploymentId);
    expect(deployment?.commit_sha).toBe("b".repeat(40));
    expect(deployment?.commit_message).toBe("second (latest)");

    // มี deployment แค่ 1 แถวสำหรับ project นี้
    const count = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM deployments WHERE project_id = ?")
      .get(projectId)!.n;
    expect(count).toBe(1);

    const jobCount = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM deploy_jobs WHERE project_id = ?")
      .get(projectId)!.n;
    expect(jobCount).toBe(1);
  });

  test("job เดิม leased อยู่ (กำลัง build) → push ใหม่สร้าง pending job ที่สอง (ไม่ coalesce เข้า leased)", () => {
    const db = makeDb();
    const projectId = insertProject(db);

    const first = enqueuePushDeploy(db, {
      projectId,
      installationId: 111,
      repoFullName: "org/repo",
      commitSha: "a".repeat(40),
      commitMessage: "first",
      commitAuthor: "Dev",
    });

    // จำลอง worker claim job แรกไปแล้ว (leased)
    db.query(
      "UPDATE deploy_jobs SET status = 'leased', lease_owner = 'worker-1' WHERE deployment_id = ?",
    ).run(first.deploymentId);

    const second = enqueuePushDeploy(db, {
      projectId,
      installationId: 111,
      repoFullName: "org/repo",
      commitSha: "b".repeat(40),
      commitMessage: "second",
      commitAuthor: "Dev",
    });

    expect(second.coalesced).toBe(false);
    expect(second.deploymentId).not.toBe(first.deploymentId);

    const jobCount = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM deploy_jobs WHERE project_id = ?")
      .get(projectId)!.n;
    expect(jobCount).toBe(2);
  });
});

describe("enqueueManualJob", () => {
  test("ไม่มีงาน active → สร้าง deployment + job สำเร็จ", () => {
    const db = makeDb();
    const projectId = insertProject(db);

    const { deploymentId } = enqueueManualJob(db, {
      projectId,
      trigger: "manual",
      commitSha: "a".repeat(40),
      commitMessage: null,
      commitAuthor: null,
      payload: {
        kind: "build",
        trigger: "manual",
        commitSha: "a".repeat(40),
        commitMessage: null,
        commitAuthor: null,
        installationId: 111,
        repoFullName: "org/repo",
      },
    });

    const deployment = db
      .query<{ status: string; trigger: string }, [string]>(
        "SELECT status, trigger FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(deployment?.status).toBe("queued");
    expect(deployment?.trigger).toBe("manual");

    const job = db
      .query<{ priority: number }, [string]>(
        "SELECT priority FROM deploy_jobs WHERE deployment_id = ?",
      )
      .get(deploymentId);
    expect(job?.priority).toBe(10); // manual > push priority
  });

  test("มีงาน pending อยู่แล้ว → throw DEPLOY_ALREADY_ACTIVE", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    enqueuePushDeploy(db, {
      projectId,
      installationId: 111,
      repoFullName: "org/repo",
      commitSha: "a".repeat(40),
      commitMessage: null,
      commitAuthor: null,
    });

    expect(() =>
      enqueueManualJob(db, {
        projectId,
        trigger: "manual",
        commitSha: "b".repeat(40),
        commitMessage: null,
        commitAuthor: null,
        payload: {
          kind: "build",
          trigger: "manual",
          commitSha: "b".repeat(40),
          commitMessage: null,
          commitAuthor: null,
          installationId: 111,
          repoFullName: "org/repo",
        },
      }),
    ).toThrow(AppError);
  });

  test("มีงาน leased อยู่แล้ว → throw DEPLOY_ALREADY_ACTIVE เช่นกัน (ต่างจาก push ที่ coalesce ได้)", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const { deploymentId } = enqueuePushDeploy(db, {
      projectId,
      installationId: 111,
      repoFullName: "org/repo",
      commitSha: "a".repeat(40),
      commitMessage: null,
      commitAuthor: null,
    });
    db.query("UPDATE deploy_jobs SET status = 'leased' WHERE deployment_id = ?").run(deploymentId);

    let caught: unknown;
    try {
      enqueueManualJob(db, {
        projectId,
        trigger: "redeploy",
        commitSha: "a".repeat(40),
        commitMessage: null,
        commitAuthor: null,
        payload: {
          kind: "build",
          trigger: "redeploy",
          commitSha: "a".repeat(40),
          commitMessage: null,
          commitAuthor: null,
          installationId: 111,
          repoFullName: "org/repo",
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("DEPLOY_ALREADY_ACTIVE");
  });
});

describe("enqueueOperation", () => {
  test("restart: มี succeeded deployment → สร้าง job อ้าง deployment นั้น", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertSucceededDeployment(db, projectId);

    const { jobId, deploymentId: refDeploymentId } = enqueueOperation(db, projectId, "restart");
    expect(refDeploymentId).toBe(deploymentId);

    const job = db
      .query<{ type: string; status: string; priority: number; payload: string }, [string]>(
        "SELECT type, status, priority, payload FROM deploy_jobs WHERE id = ?",
      )
      .get(jobId);
    expect(job?.type).toBe("deploy");
    expect(job?.status).toBe("pending");
    expect(job?.priority).toBe(20);
    expect(JSON.parse(job!.payload)).toEqual({ kind: "restart" });

    // restart ไม่สร้าง deployment แถวใหม่
    const count = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM deployments WHERE project_id = ?")
      .get(projectId)!.n;
    expect(count).toBe(1);
  });

  test("stop: payload เป็น {kind:'stop'}", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertSucceededDeployment(db, projectId);

    const { jobId } = enqueueOperation(db, projectId, "stop");
    const job = db
      .query<{ payload: string }, [string]>("SELECT payload FROM deploy_jobs WHERE id = ?")
      .get(jobId);
    expect(JSON.parse(job!.payload)).toEqual({ kind: "stop" });
  });

  test("ไม่มี succeeded deployment เลย → throw VALIDATION_ERROR", () => {
    const db = makeDb();
    const projectId = insertProject(db);

    let caught: unknown;
    try {
      enqueueOperation(db, projectId, "restart");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("VALIDATION_ERROR");
  });

  test("มีงาน active อยู่แล้ว → throw DEPLOY_ALREADY_ACTIVE", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertSucceededDeployment(db, projectId);
    enqueuePushDeploy(db, {
      projectId,
      installationId: 1,
      repoFullName: "o/r",
      commitSha: "a".repeat(40),
      commitMessage: null,
      commitAuthor: null,
    });

    expect(() => enqueueOperation(db, projectId, "restart")).toThrow(AppError);
  });
});

describe("cancelDeployment", () => {
  test("pending job → job และ deployment กลายเป็น cancelled ทันที", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const { deploymentId } = enqueuePushDeploy(db, {
      projectId,
      installationId: 1,
      repoFullName: "o/r",
      commitSha: "a".repeat(40),
      commitMessage: null,
      commitAuthor: null,
    });

    cancelDeployment(db, deploymentId);

    const deployment = db
      .query<{ status: string }, [string]>("SELECT status FROM deployments WHERE id = ?")
      .get(deploymentId);
    expect(deployment?.status).toBe("cancelled");

    const job = db
      .query<{ status: string }, [string]>("SELECT status FROM deploy_jobs WHERE deployment_id = ?")
      .get(deploymentId);
    expect(job?.status).toBe("cancelled");
  });

  test("leased job → ตั้ง cancel_requested_at แทนแตะ status/lease โดยตรง", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const { deploymentId } = enqueuePushDeploy(db, {
      projectId,
      installationId: 1,
      repoFullName: "o/r",
      commitSha: "a".repeat(40),
      commitMessage: null,
      commitAuthor: null,
    });
    db.query(
      "UPDATE deploy_jobs SET status = 'leased', lease_owner = 'worker-1', lease_expires_at = ? WHERE deployment_id = ?",
    ).run(Date.now() + 60_000, deploymentId);

    cancelDeployment(db, deploymentId);

    const job = db
      .query<{ status: string; cancel_requested_at: number | null; lease_owner: string }, [string]>(
        "SELECT status, cancel_requested_at, lease_owner FROM deploy_jobs WHERE deployment_id = ?",
      )
      .get(deploymentId);
    // status/lease_owner ไม่ถูกแตะ — ยังเป็น leased/worker-1 เดิม (worker จะจัดการเองตอน poll)
    expect(job?.status).toBe("leased");
    expect(job?.lease_owner).toBe("worker-1");
    expect(job?.cancel_requested_at).not.toBeNull();

    // deployment เองยังไม่ถูกแตะ (worker เป็นคน mark cancelled จริงตอนเห็น flag)
    const deployment = db
      .query<{ status: string }, [string]>("SELECT status FROM deployments WHERE id = ?")
      .get(deploymentId);
    expect(deployment?.status).toBe("queued");
  });

  test("cancel deployment ที่ terminal อยู่แล้ว (succeeded) → no-op idempotent", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertSucceededDeployment(db, projectId);

    // ไม่ throw
    cancelDeployment(db, deploymentId);

    const deployment = db
      .query<{ status: string }, [string]>("SELECT status FROM deployments WHERE id = ?")
      .get(deploymentId);
    expect(deployment?.status).toBe("succeeded"); // ไม่เปลี่ยน
  });

  test("cancel deployment ที่ไม่มี job ผูกอยู่เลย (edge case) → mark deployment cancelled ถ้ายัง non-terminal", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = ulid();
    const now = Date.now();
    db.query(
      `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
       VALUES (?, ?, 'building', 'push', ?, ?, ?, ?)`,
    ).run(deploymentId, projectId, "a".repeat(40), now, now, now);

    cancelDeployment(db, deploymentId);

    const deployment = db
      .query<{ status: string }, [string]>("SELECT status FROM deployments WHERE id = ?")
      .get(deploymentId);
    expect(deployment?.status).toBe("cancelled");
  });
});
