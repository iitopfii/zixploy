import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import {
  claimNextJob,
  completeJob,
  failJob,
  LeaseLostError,
  recoverStaleLeases,
  renewLease,
  withLeaseRenewal,
} from "../src/queue";

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

function insertJob(
  db: ReturnType<typeof openDatabase>,
  opts: {
    id?: string;
    projectId: string;
    deploymentId?: string | null;
    type?: "deploy" | "cleanup";
    status?: "pending" | "leased" | "done" | "failed" | "cancelled";
    priority?: number;
    createdAt?: number;
    leaseOwner?: string | null;
    leaseExpiresAt?: number | null;
    attempts?: number;
    maxAttempts?: number;
    cancelRequestedAt?: number | null;
  },
) {
  const id = opts.id ?? ulid();
  const now = opts.createdAt ?? Date.now();
  db.query(
    `INSERT INTO deploy_jobs
      (id, project_id, deployment_id, type, status, payload, priority, attempts, max_attempts, lease_owner, lease_expires_at, cancel_requested_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.projectId,
    opts.deploymentId ?? null,
    opts.type ?? "deploy",
    opts.status ?? "pending",
    opts.priority ?? 0,
    opts.attempts ?? 0,
    opts.maxAttempts ?? 1,
    opts.leaseOwner ?? null,
    opts.leaseExpiresAt ?? null,
    opts.cancelRequestedAt ?? null,
    now,
    now,
  );
  return id;
}

function insertDeployment(
  db: ReturnType<typeof openDatabase>,
  opts: { id?: string; projectId: string; status?: string },
) {
  const id = opts.id ?? ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
     VALUES (?, ?, ?, 'push', ?, ?, ?, ?)`,
  ).run(id, opts.projectId, opts.status ?? "building", "a".repeat(40), now, now, now);
  return id;
}

describe("claimNextJob", () => {
  test("claim job เดียวที่มีอยู่ — คืน field ครบ", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const jobId = insertJob(db, { projectId, priority: 5, maxAttempts: 3 });

    const job = claimNextJob(db, "worker-1", 60_000);
    expect(job).not.toBeNull();
    expect(job?.id).toBe(jobId);
    expect(job?.projectId).toBe(projectId);
    expect(job?.status).toBe("leased");
    expect(job?.attempts).toBe(1); // increment ตอน claim
    expect(job?.maxAttempts).toBe(3);

    const row = db
      .query<{ status: string; lease_owner: string }, [string]>(
        "SELECT status, lease_owner FROM deploy_jobs WHERE id = ?",
      )
      .get(jobId);
    expect(row?.status).toBe("leased");
    expect(row?.lease_owner).toBe("worker-1");
  });

  test("ไม่มีงาน pending → คืน null", () => {
    const db = makeDb();
    expect(claimNextJob(db, "worker-1", 60_000)).toBeNull();
  });

  test("claim สองครั้งติดกันโดยมีงาน pending แค่ 1 → ครั้งที่สองได้ null", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertJob(db, { projectId });

    const first = claimNextJob(db, "worker-1", 60_000);
    const second = claimNextJob(db, "worker-1", 60_000);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test("priority สูงกว่าถูก claim ก่อน (คนละ project กันเพราะ 1 pending ต่อ project+type)", () => {
    const db = makeDb();
    const lowProject = insertProject(db);
    const highProject = insertProject(db);
    const lowId = insertJob(db, {
      projectId: lowProject,
      priority: 0,
      createdAt: Date.now() - 1000,
    });
    const highId = insertJob(db, { projectId: highProject, priority: 10, createdAt: Date.now() });

    const job = claimNextJob(db, "worker-1", 60_000);
    expect(job?.id).toBe(highId);
    void lowId;
  });

  test("priority เท่ากัน → created_at เก่าสุดถูก claim ก่อน (FIFO, คนละ project)", () => {
    const db = makeDb();
    const olderProject = insertProject(db);
    const newerProject = insertProject(db);
    const olderId = insertJob(db, {
      projectId: olderProject,
      priority: 0,
      createdAt: Date.now() - 5000,
    });
    insertJob(db, { projectId: newerProject, priority: 0, createdAt: Date.now() });

    const job = claimNextJob(db, "worker-1", 60_000);
    expect(job?.id).toBe(olderId);
  });

  test("claim หนึ่ง job ต่อ transaction เดียว — job อื่น project อื่นยัง claim ได้", () => {
    const db = makeDb();
    const p1 = insertProject(db);
    const p2 = insertProject(db);
    insertJob(db, { projectId: p1 });
    insertJob(db, { projectId: p2 });

    const job1 = claimNextJob(db, "worker-1", 60_000);
    const job2 = claimNextJob(db, "worker-1", 60_000);
    expect(job1).not.toBeNull();
    expect(job2).not.toBeNull();
    expect(job1?.id).not.toBe(job2?.id);
  });
});

describe("recoverStaleLeases", () => {
  test("leased job ที่ lease หมดอายุแล้วและยัง retry ได้ → กลับเป็น pending", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const jobId = insertJob(db, {
      projectId,
      status: "leased",
      leaseOwner: "dead-worker",
      leaseExpiresAt: Date.now() - 10_000,
      attempts: 1,
      maxAttempts: 3,
    });

    const recovered = recoverStaleLeases(db);
    expect(recovered).toBe(1);

    const row = db
      .query<{ status: string; lease_owner: string | null }, [string]>(
        "SELECT status, lease_owner FROM deploy_jobs WHERE id = ?",
      )
      .get(jobId);
    expect(row?.status).toBe("pending");
    expect(row?.lease_owner).toBeNull();
  });

  test("attempts หมดแล้ว → job เป็น failed และ deployment ที่ผูกอยู่ (ยัง non-terminal) เป็น failed ด้วย", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, { projectId, status: "building" });
    const jobId = insertJob(db, {
      projectId,
      deploymentId,
      status: "leased",
      leaseOwner: "dead-worker",
      leaseExpiresAt: Date.now() - 10_000,
      attempts: 3,
      maxAttempts: 3,
    });

    recoverStaleLeases(db);

    const job = db
      .query<{ status: string }, [string]>("SELECT status FROM deploy_jobs WHERE id = ?")
      .get(jobId);
    expect(job?.status).toBe("failed");

    const deployment = db
      .query<{ status: string; failure_code: string | null }, [string]>(
        "SELECT status, failure_code FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(deployment?.status).toBe("failed");
    expect(deployment?.failure_code).toBe("WORKER_LEASE_EXPIRED");
  });

  test("deployment ที่ terminal อยู่แล้ว (เช่น cancelled) ไม่ถูกแตะซ้ำ", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const deploymentId = insertDeployment(db, { projectId, status: "cancelled" });
    insertJob(db, {
      projectId,
      deploymentId,
      status: "leased",
      leaseOwner: "dead-worker",
      leaseExpiresAt: Date.now() - 10_000,
      attempts: 1,
      maxAttempts: 1,
    });

    recoverStaleLeases(db);

    const deployment = db
      .query<{ status: string; failure_code: string | null }, [string]>(
        "SELECT status, failure_code FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(deployment?.status).toBe("cancelled");
    expect(deployment?.failure_code).toBeNull();
  });

  test("lease ยังไม่หมดอายุ → ไม่ถูกแตะ", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const jobId = insertJob(db, {
      projectId,
      status: "leased",
      leaseOwner: "alive-worker",
      leaseExpiresAt: Date.now() + 60_000,
    });

    const recovered = recoverStaleLeases(db);
    expect(recovered).toBe(0);

    const row = db
      .query<{ status: string }, [string]>("SELECT status FROM deploy_jobs WHERE id = ?")
      .get(jobId);
    expect(row?.status).toBe("leased");
  });

  test("claimNextJob เรียก recoverStaleLeases ให้อัตโนมัติก่อน claim ใหม่", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertJob(db, {
      projectId,
      status: "leased",
      leaseOwner: "dead-worker",
      leaseExpiresAt: Date.now() - 10_000,
      attempts: 0,
      maxAttempts: 3,
    });

    // job นี้ recover เป็น pending แล้ว claim ได้ทันทีในคำเรียกเดียว
    const job = claimNextJob(db, "worker-2", 60_000);
    expect(job).not.toBeNull();
    expect(job?.attempts).toBe(1);
  });
});

describe("renewLease", () => {
  test("renew สำเร็จเมื่อยัง owned อยู่ — คืน true และขยาย lease_expires_at", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertJob(db, {
      projectId,
      status: "leased",
      leaseOwner: "worker-1",
      leaseExpiresAt: Date.now() + 1000,
    });
    const jobId = db.query<{ id: string }, []>("SELECT id FROM deploy_jobs").get()!.id;

    const before = db
      .query<{ lease_expires_at: number }, [string]>(
        "SELECT lease_expires_at FROM deploy_jobs WHERE id = ?",
      )
      .get(jobId)!.lease_expires_at;

    const renewed = renewLease(db, jobId, "worker-1", 60_000);
    expect(renewed).toBe(true);

    const after = db
      .query<{ lease_expires_at: number }, [string]>(
        "SELECT lease_expires_at FROM deploy_jobs WHERE id = ?",
      )
      .get(jobId)!.lease_expires_at;
    expect(after).toBeGreaterThan(before);
  });

  test("worker อื่นถือ lease อยู่ (ถูก steal ไปแล้ว) → คืน false", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertJob(db, {
      projectId,
      status: "leased",
      leaseOwner: "worker-2", // คนละคนกับที่จะ renew
      leaseExpiresAt: Date.now() + 60_000,
    });
    const jobId = db.query<{ id: string }, []>("SELECT id FROM deploy_jobs").get()!.id;

    const renewed = renewLease(db, jobId, "worker-1", 60_000);
    expect(renewed).toBe(false);
  });

  test("job ไม่ใช่ leased แล้ว (เช่นถูก recover เป็น pending) → คืน false", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const jobId = insertJob(db, { projectId, status: "pending" });

    const renewed = renewLease(db, jobId, "worker-1", 60_000);
    expect(renewed).toBe(false);
  });
});

describe("withLeaseRenewal", () => {
  test("fn สำเร็จปกติ + lease ถูกต่ออายุระหว่างทาง (renewIntervalMs สั้นเพื่อเทสต์)", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertJob(db, { projectId });
    const job = claimNextJob(db, "worker-1", 500); // lease สั้นมากเพื่อพิสูจน์ว่า renew จริง
    expect(job).not.toBeNull();
    if (!job) return;

    let renewCountObserved = 0;
    const before = db
      .query<{ lease_expires_at: number }, [string]>(
        "SELECT lease_expires_at FROM deploy_jobs WHERE id = ?",
      )
      .get(job.id)!.lease_expires_at;

    const result = await withLeaseRenewal(
      db,
      job,
      "worker-1",
      async () => {
        // รอนานพอให้ renew loop วิ่งอย่างน้อย 2 รอบ (interval 20ms)
        await new Promise((r) => setTimeout(r, 90));
        const row = db
          .query<{ lease_expires_at: number }, [string]>(
            "SELECT lease_expires_at FROM deploy_jobs WHERE id = ?",
          )
          .get(job.id)!;
        renewCountObserved = row.lease_expires_at > before ? 1 : 0;
        return "ok";
      },
      { renewIntervalMs: 20, leaseMs: 500 },
    );

    expect(result).toBe("ok");
    expect(renewCountObserved).toBe(1);
  });

  test("renew ล้มเหลว (lease ถูก steal) → โยน LeaseLostError(expired)", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertJob(db, { projectId });
    const job = claimNextJob(db, "worker-1", 500);
    expect(job).not.toBeNull();
    if (!job) return;

    let thrown: unknown;
    try {
      await withLeaseRenewal(
        db,
        job,
        "worker-1",
        async () => {
          // จำลอง worker อื่น steal lease กลางทาง
          await new Promise((r) => setTimeout(r, 15));
          db.query("UPDATE deploy_jobs SET lease_owner = 'thief' WHERE id = ?").run(job.id);
          await new Promise((r) => setTimeout(r, 40)); // ให้ renew loop เจอ steal
        },
        { renewIntervalMs: 20, leaseMs: 500 },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(LeaseLostError);
    expect((thrown as LeaseLostError).reason).toBe("expired");
  });

  test("cancel_requested_at ถูกตั้งกลางทาง → โยน LeaseLostError(cancelled) และ signal ถูก abort", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertJob(db, { projectId });
    const job = claimNextJob(db, "worker-1", 500);
    expect(job).not.toBeNull();
    if (!job) return;

    let signalAbortedInsideFn = false;
    let thrown: unknown;
    try {
      await withLeaseRenewal(
        db,
        job,
        "worker-1",
        async (signal) => {
          db.query("UPDATE deploy_jobs SET cancel_requested_at = ? WHERE id = ?").run(
            Date.now(),
            job.id,
          );
          // รอให้ renew loop เห็น cancel_requested_at แล้ว abort signal
          await new Promise((r) => setTimeout(r, 40));
          signalAbortedInsideFn = signal.aborted;
        },
        { renewIntervalMs: 15, leaseMs: 500 },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(LeaseLostError);
    expect((thrown as LeaseLostError).reason).toBe("cancelled");
    expect(signalAbortedInsideFn).toBe(true);
  });

  test("fn throw ธรรมดา (ไม่เกี่ยวกับ lease) → error เดิม propagate ออกไป ไม่ใช่ LeaseLostError", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertJob(db, { projectId });
    const job = claimNextJob(db, "worker-1", 60_000);
    expect(job).not.toBeNull();
    if (!job) return;

    let thrown: unknown;
    try {
      await withLeaseRenewal(db, job, "worker-1", async () => {
        throw new Error("build failed for reasons unrelated to lease");
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("build failed for reasons unrelated to lease");
    expect(thrown).not.toBeInstanceOf(LeaseLostError);
  });
});

describe("completeJob / failJob", () => {
  test("completeJob → status='done', lease field เคลียร์", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    insertJob(db, { projectId });
    const job = claimNextJob(db, "worker-1", 60_000);
    expect(job).not.toBeNull();
    if (!job) return;

    completeJob(db, job.id);

    const row = db
      .query<{ status: string; lease_owner: string | null }, [string]>(
        "SELECT status, lease_owner FROM deploy_jobs WHERE id = ?",
      )
      .get(job.id);
    expect(row?.status).toBe("done");
    expect(row?.lease_owner).toBeNull();
  });

  test("failJob retryable=true และ attempts < max_attempts → กลับเป็น pending", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const jobId = insertJob(db, { projectId, status: "leased", attempts: 1, maxAttempts: 3 });

    failJob(db, jobId, { retryable: true });

    const row = db
      .query<{ status: string }, [string]>("SELECT status FROM deploy_jobs WHERE id = ?")
      .get(jobId);
    expect(row?.status).toBe("pending");
  });

  test("failJob retryable=true แต่ attempts >= max_attempts → failed ถาวร (ไม่ retry เกินกำหนด)", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const jobId = insertJob(db, { projectId, status: "leased", attempts: 3, maxAttempts: 3 });

    failJob(db, jobId, { retryable: true });

    const row = db
      .query<{ status: string }, [string]>("SELECT status FROM deploy_jobs WHERE id = ?")
      .get(jobId);
    expect(row?.status).toBe("failed");
  });

  test("failJob retryable=false → failed ทันทีไม่สน attempts (ใช้กับ build error)", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const jobId = insertJob(db, { projectId, status: "leased", attempts: 1, maxAttempts: 5 });

    failJob(db, jobId, { retryable: false });

    const row = db
      .query<{ status: string }, [string]>("SELECT status FROM deploy_jobs WHERE id = ?")
      .get(jobId);
    expect(row?.status).toBe("failed");
  });
});
