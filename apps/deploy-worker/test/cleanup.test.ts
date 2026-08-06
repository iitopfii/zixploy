/**
 * cleanupProjectImages tests — mock DockerCliClient เต็มรูปแบบ ไม่ต้องมี Docker จริง
 */
import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { cleanupProjectImages } from "../src/pipeline/cleanup";

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
     VALUES (?, 'p', 'running', 'Dockerfile', '.', ?, ?)`,
  ).run(id, now, now);
  return id;
}

/** สร้าง deployment succeeded พร้อม image_tag — finishedAt กำหนดเองเพื่อคุม "ล่าสุด N รายการ" */
function insertSucceededDeployment(
  db: ReturnType<typeof openDatabase>,
  projectId: string,
  imageTag: string,
  finishedAt: number,
) {
  const id = ulid();
  db.query(
    `INSERT INTO deployments
      (id, project_id, status, trigger, commit_sha, image_tag, queued_at, finished_at, created_at, updated_at)
     VALUES (?, ?, 'succeeded', 'manual', ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, "a".repeat(40), imageTag, finishedAt, finishedAt, finishedAt, finishedAt);
  return id;
}

function mockDocker(overrides: Record<string, unknown> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, impl: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return impl(...args);
    };
  return {
    calls,
    listContainersByLabel: record("listContainersByLabel", async () => []),
    listImagesByLabel: record("listImagesByLabel", async () => []),
    inspectImage: record("inspectImage", async () => null),
    removeImage: record("removeImage", async () => undefined),
    ...overrides,
  };
}

function img(repository: string, tag: string, id = `sha256:${ulid().toLowerCase()}`) {
  return { ID: id.slice(0, 19), Repository: repository, Tag: tag };
}

/** แยก "repo:tag" เป็นสองส่วนแบบ type-safe — ไม่พึ่ง String#split's noUncheckedIndexedAccess result */
function imgFromRef(ref: string) {
  const sepIndex = ref.lastIndexOf(":");
  return img(ref.slice(0, sepIndex), ref.slice(sepIndex + 1));
}

describe("cleanupProjectImages — retention (keep N ล่าสุด)", () => {
  test("มี image เกิน keepCount → ลบตัวเก่าสุด เก็บ N ตัวล่าสุดไว้", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const repo = `zixploy/${projectId.toLowerCase()}`;

    // 5 deployments succeeded, finishedAt ต่างกัน — keepCount=3 ต้องเก็บ 3 ตัวล่าสุด (t5,t4,t3)
    const tags = ["t1", "t2", "t3", "t4", "t5"].map((t, i) => {
      const tag = `${repo}:${t}`;
      insertSucceededDeployment(db, projectId, tag, 1000 + i * 10);
      return tag;
    });

    const images = tags.map(imgFromRef);
    const docker = mockDocker({
      listImagesByLabel: async () => images,
      inspectImage: async (ref: string) => ({
        Id: `sha256:${ref}`,
        RepoDigests: [],
        Config: { Labels: { "platform.project_id": projectId } },
      }),
    });

    const result = await cleanupProjectImages({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: db as any,
      docker: docker as unknown as Parameters<typeof cleanupProjectImages>[0]["docker"],
      projectId,
      keepCount: 3,
      onLog: () => {},
    });

    expect(result.removed.sort()).toEqual([`${repo}:t1`, `${repo}:t2`].sort());
    expect(result.skipped.sort()).toEqual([`${repo}:t3`, `${repo}:t4`, `${repo}:t5`].sort());
  });

  test("image น้อยกว่าหรือเท่ากับ keepCount → ไม่ลบอะไรเลย", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const repo = `zixploy/${projectId.toLowerCase()}`;

    const tags = ["t1", "t2"].map((t, i) => {
      const tag = `${repo}:${t}`;
      insertSucceededDeployment(db, projectId, tag, 1000 + i * 10);
      return tag;
    });
    const images = tags.map(imgFromRef);
    const docker = mockDocker({ listImagesByLabel: async () => images });

    const result = await cleanupProjectImages({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: db as any,
      docker: docker as unknown as Parameters<typeof cleanupProjectImages>[0]["docker"],
      projectId,
      keepCount: 3,
      onLog: () => {},
    });

    expect(result.removed).toEqual([]);
    expect(docker.calls.some((c) => c.method === "removeImage")).toBe(false);
  });
});

describe("cleanupProjectImages — double-check container ยังใช้อยู่", () => {
  test("image เก่ากว่า keep set แต่มี container (แม้ stopped) อ้างอิงอยู่ → skip ไม่ลบ", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const repo = `zixploy/${projectId.toLowerCase()}`;

    // เก็บแค่ t1 ไว้ (keepCount=1), t0 เป็นตัวเก่าที่ควรถูกลบแต่มี container เก่าที่ยังไม่ถูกลบใช้อยู่
    insertSucceededDeployment(db, projectId, `${repo}:t1`, 2000);
    const oldTag = `${repo}:t0`;

    const docker = mockDocker({
      listImagesByLabel: async () => [img(repo, "t0"), img(repo, "t1")],
      listContainersByLabel: async () => [{ ID: "c1", Names: "/old", Image: oldTag, Labels: "" }],
    });

    const result = await cleanupProjectImages({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: db as any,
      docker: docker as unknown as Parameters<typeof cleanupProjectImages>[0]["docker"],
      projectId,
      keepCount: 1,
      onLog: () => {},
    });

    expect(result.removed).not.toContain(oldTag);
    expect(result.skipped).toContain(oldTag);
    expect(docker.calls.some((c) => c.method === "removeImage" && c.args[0] === oldTag)).toBe(
      false,
    );
  });
});

describe("cleanupProjectImages — ADR-0005 re-verify ก่อนลบจริง", () => {
  test("image label project_id ไม่ตรงตอน re-verify (แม้ list filter จะคืนมาแล้ว) → skip ไม่ลบเด็ดขาด", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const otherProjectId = "01JOTHERPROJECT0000000001";
    const repo = `zixploy/${projectId.toLowerCase()}`;
    const staleTag = `${repo}:stale`;

    // ไม่มี deployment succeeded ใน DB เลย (keep set ว่าง) — stale ควรถูกลบตามปกติ
    // แต่ inspectImage (re-verify) คืน label project_id ของ "โปรเจกต์อื่น" — ต้อง skip เด็ดขาด
    const docker = mockDocker({
      listImagesByLabel: async () => [img(repo, "stale")],
      inspectImage: async () => ({
        Id: "sha256:mismatched",
        RepoDigests: [],
        Config: { Labels: { "platform.project_id": otherProjectId } },
      }),
    });

    const result = await cleanupProjectImages({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: db as any,
      docker: docker as unknown as Parameters<typeof cleanupProjectImages>[0]["docker"],
      projectId,
      keepCount: 3,
      onLog: () => {},
    });

    expect(result.removed).not.toContain(staleTag);
    expect(result.skipped).toContain(staleTag);
    expect(docker.calls.some((c) => c.method === "removeImage")).toBe(false);
  });

  test("re-verify: image หายไปแล้วระหว่างทาง (inspectImage คืน null) → ข้ามเงียบ ๆ ไม่ throw", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const repo = `zixploy/${projectId.toLowerCase()}`;

    const docker = mockDocker({
      listImagesByLabel: async () => [img(repo, "gone")],
      inspectImage: async () => null,
    });

    const result = await cleanupProjectImages({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: db as any,
      docker: docker as unknown as Parameters<typeof cleanupProjectImages>[0]["docker"],
      projectId,
      keepCount: 3,
      onLog: () => {},
    });

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});

describe("cleanupProjectImages — best-effort ต่อ image เดียว", () => {
  test("removeImage บาง image throw (race) → skip เฉพาะตัวนั้น ตัวอื่นลบต่อได้ปกติ", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const repo = `zixploy/${projectId.toLowerCase()}`;

    const docker = mockDocker({
      listImagesByLabel: async () => [img(repo, "a"), img(repo, "b")],
      inspectImage: async () => ({
        Id: "sha256:x",
        RepoDigests: [],
        Config: { Labels: { "platform.project_id": projectId } },
      }),
      removeImage: async (ref: string) => {
        if (ref === `${repo}:a`) throw new Error("image is being used by a container");
      },
    });

    const result = await cleanupProjectImages({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: db as any,
      docker: docker as unknown as Parameters<typeof cleanupProjectImages>[0]["docker"],
      projectId,
      keepCount: 0,
      onLog: () => {},
    });

    expect(result.skipped).toContain(`${repo}:a`);
    expect(result.removed).toContain(`${repo}:b`);
  });
});
