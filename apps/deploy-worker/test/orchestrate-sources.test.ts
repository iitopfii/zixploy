/**
 * runComposePipeline — repo/branch ต่อ build component + build arg/secret ต่อ component (0.1.25)
 *
 * ครอบคลุม: component ที่มี repo ของตัวเอง resolve branch → commit แล้ว clone แยก dir, repo@commit
 * เดียวกัน clone ครั้งเดียว, commit ถูกบันทึกใน deployments.component_commits, redeploy ปัก commit เดิม
 * (ไม่ resolve ใหม่), โปรเจกต์ที่ไม่มี source แต่ทุก build component มี repo เอง deploy ได้,
 * build secret ส่งเป็น --secret file (ของ component ทับของ project) และไฟล์ถูกลบหลัง build
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import type { BuildImageParams } from "../src/docker/buildkit";
import type { EnvInjection } from "../src/env/inject";
import { encryptEnvelope } from "../src/github/envelope";
import { createMasterKeys, type MasterKeys } from "../src/github/master-key";
import type { OrchestrateDeps } from "../src/pipeline/orchestrate";
import { mergeBuildEnv, runComposePipeline } from "../src/pipeline/orchestrate";
import type { ClaimedJob } from "../src/queue";

const root = mkdtempSync(join(tmpdir(), "zixploy-orch-sources-"));
process.env.ZIXPLOY_WORKSPACES_DIR = root;
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows อาจปล่อย handle ช้า
  }
});

type Db = ReturnType<typeof openDatabase>;

const PROJECT_SHA = "a".repeat(40);
const WEB_HEAD = "c".repeat(40);

function makeDb(): Db {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function insertProject(db: Db): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO projects
      (id, name, status, mode, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'multi', 'new', 'compose', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(id, now, now);
  return id;
}

function insertInstallation(db: Db, installationId: number, status = "active"): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO github_installations
      (id, installation_id, account_login, account_type, account_avatar_url, status, created_at, updated_at)
     VALUES (?, ?, 'acme', 'Organization', 'https://example.com/a.png', ?, ?, ?)`,
  ).run(id, installationId, status, now, now);
  return id;
}

function insertBuildComponent(
  db: Db,
  projectId: string,
  c: {
    name: string;
    isWeb?: boolean;
    position: number;
    source?: { installationRowId: string; repo: string; branch: string };
  },
): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO project_components
      (id, project_id, name, role, source_kind, dockerfile_path, build_context, is_web, web_port,
       position, enabled, repo_installation_id, repo_full_name, repo_branch, created_at, updated_at)
     VALUES (?, ?, ?, 'app', 'build', 'Dockerfile', '.', ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    c.name,
    c.isWeb ? 1 : 0,
    c.isWeb ? 3000 : null,
    c.position,
    c.source?.installationRowId ?? null,
    c.source?.repo ?? null,
    c.source?.branch ?? null,
    now,
    now,
  );
  return id;
}

async function insertEnv(
  db: Db,
  keys: MasterKeys,
  projectId: string,
  e: { key: string; value: string; secret: boolean; scope: string; componentId?: string },
): Promise<void> {
  const now = Date.now();
  db.query(
    `INSERT INTO environment_variables
      (id, project_id, key, value_ciphertext, is_secret, scope, enabled, version, created_at, updated_at, component_id)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
  ).run(
    ulid(),
    projectId,
    e.key,
    await encryptEnvelope(keys, e.value, `env:${projectId}:${e.key}`),
    e.secret ? 1 : 0,
    e.scope,
    now,
    now,
    e.componentId ?? null,
  );
}

function insertDeployment(db: Db, projectId: string): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
     VALUES (?, ?, 'queued', 'manual', ?, ?, ?, ?)`,
  ).run(id, projectId, PROJECT_SHA, now, now, now);
  return id;
}

function makeJob(projectId: string, deploymentId: string): ClaimedJob {
  return {
    id: ulid(),
    projectId,
    deploymentId,
    type: "deploy",
    status: "leased",
    payload: {},
    attempts: 1,
    maxAttempts: 1,
  };
}

function mockDocker() {
  return {
    ping: async () => true,
    inspectContainer: async () => null,
    ensureNetwork: async () => ({ networkId: "net1" }),
    removeNetwork: async () => undefined,
    pullImage: async () => undefined,
    removeContainer: async () => undefined,
    createContainer: async (p: { networkAliases?: string[]; name: string }) => ({
      containerId: `cid-${p.networkAliases?.[0] ?? p.name}`,
    }),
    connectNetwork: async () => undefined,
    createVolume: async () => undefined,
    startContainer: async () => undefined,
    stopContainer: async () => undefined,
  };
}

interface Recorder {
  clones: Array<{ repoFullName: string; commitSha: string; destDir: string }>;
  resolves: Array<{ repoFullName: string; branch: string }>;
  builds: Array<BuildImageParams & { secretContents: Record<string, string> }>;
  tokensFor: number[];
}

function makeDeps(db: Db, masterKeys: MasterKeys | null): { deps: OrchestrateDeps; rec: Recorder } {
  const rec: Recorder = { clones: [], resolves: [], builds: [], tokensFor: [] };
  const deps: OrchestrateDeps = {
    db,
    // biome-ignore lint/suspicious/noExplicitAny: mock docker — ไม่ implement ทุก method
    docker: mockDocker() as any,
    masterKeys,
    mintInstallationToken: async (_db, _k, installationId) => {
      rec.tokensFor.push(installationId);
      return { token: `tok-${installationId}`, expiresAt: new Date() };
    },
    cloneCommit: async (p) => {
      rec.clones.push({ repoFullName: p.repoFullName, commitSha: p.commitSha, destDir: p.destDir });
      mkdirSync(p.destDir, { recursive: true });
      writeFileSync(join(p.destDir, "Dockerfile"), "FROM scratch\n");
    },
    resolveBranchHead: async (p) => {
      rec.resolves.push({ repoFullName: p.repoFullName, branch: p.branch });
      return WEB_HEAD;
    },
    buildImage: async (p) => {
      // อ่านไฟล์ secret ตอน build (หลังจากนี้ต้องถูกลบ)
      const secretContents: Record<string, string> = {};
      for (const s of p.secrets ?? []) secretContents[s.id] = readFileSync(s.sourcePath, "utf8");
      rec.builds.push({ ...p, secretContents });
      return { imageId: "sha256:abc", digest: "sha256:abc" };
    },
    waitForHealthy: async () => undefined,
    waitForContainerHealthy: async () => "healthy" as const,
    buildManagedRefEnv: async () => ({}),
    onLog: () => {},
    drainMs: 0,
  };
  return { deps, rec };
}

const GITHUB_PAYLOAD = {
  kind: "build" as const,
  trigger: "manual" as const,
  commitSha: PROJECT_SHA,
  commitMessage: null,
  commitAuthor: null,
  source: { type: "github" as const, installationId: 111, repoFullName: "acme/backend" },
};

function componentCommits(db: Db, deploymentId: string): Record<string, string> | null {
  const row = db
    .query<{ component_commits: string | null }, [string]>(
      "SELECT component_commits FROM deployments WHERE id = ?",
    )
    .get(deploymentId);
  return row?.component_commits ? JSON.parse(row.component_commits) : null;
}

describe("runComposePipeline — repo ต่อ component (0.1.25)", () => {
  test("component ที่มี repo เอง: resolve branch, clone แยก dir, tag ใช้ commit ของตัวเอง, บันทึก commit", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const inst = insertInstallation(db, 222);
    const api = insertBuildComponent(db, projectId, { name: "api", position: 0 });
    const web = insertBuildComponent(db, projectId, {
      name: "web",
      isWeb: true,
      position: 1,
      source: { installationRowId: inst, repo: "acme/frontend", branch: "uat" },
    });
    const deploymentId = insertDeployment(db, projectId);
    const { deps, rec } = makeDeps(db, null);

    const out = await runComposePipeline(
      deps,
      makeJob(projectId, deploymentId),
      GITHUB_PAYLOAD,
      new AbortController().signal,
    );
    expect(out.outcome).toBe("done");

    expect(rec.resolves).toEqual([{ repoFullName: "acme/frontend", branch: "uat" }]);
    expect(rec.tokensFor).toEqual([111, 222]);
    expect(rec.clones.map((c) => [c.repoFullName, c.commitSha])).toEqual([
      ["acme/backend", PROJECT_SHA],
      ["acme/frontend", WEB_HEAD],
    ]);
    // แต่ละ repo อยู่ dir แยก ไม่ซ้อนกัน
    const [projectDir, webDir] = rec.clones.map((c) => c.destDir);
    expect(projectDir).not.toBe(webDir);
    expect(webDir?.startsWith(`${projectDir}`)).toBe(false);

    const byName = new Map(rec.builds.map((b) => [b.labels["platform.component_id"], b]));
    expect(byName.get(api)?.contextDir.startsWith(projectDir ?? "?")).toBe(true);
    expect(byName.get(web)?.contextDir.startsWith(webDir ?? "?")).toBe(true);
    expect(byName.get(web)?.tag).toContain(WEB_HEAD.slice(0, 7));
    expect(byName.get(api)?.tag).toContain(PROJECT_SHA.slice(0, 7));

    expect(componentCommits(db, deploymentId)).toEqual({ [web]: WEB_HEAD });
    db.close();
  });

  test("redeploy ปัก commit เดิม — ไม่ resolve branch ใหม่", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const inst = insertInstallation(db, 222);
    insertBuildComponent(db, projectId, { name: "api", position: 0 });
    const web = insertBuildComponent(db, projectId, {
      name: "web",
      isWeb: true,
      position: 1,
      source: { installationRowId: inst, repo: "acme/frontend", branch: "uat" },
    });
    const deploymentId = insertDeployment(db, projectId);
    const { deps, rec } = makeDeps(db, null);
    const pinned = "d".repeat(40);

    const out = await runComposePipeline(
      deps,
      makeJob(projectId, deploymentId),
      { ...GITHUB_PAYLOAD, trigger: "redeploy", componentCommits: { [web]: pinned } },
      new AbortController().signal,
    );
    expect(out.outcome).toBe("done");
    expect(rec.resolves).toEqual([]);
    expect(rec.clones.find((c) => c.repoFullName === "acme/frontend")?.commitSha).toBe(pinned);
    expect(componentCommits(db, deploymentId)).toEqual({ [web]: pinned });
    db.close();
  });

  test("repo@commit เดียวกันสองตัว clone ครั้งเดียว · project ไม่มี source ก็ได้ถ้าทุกตัวมี repo เอง", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const inst = insertInstallation(db, 222);
    const src = { installationRowId: inst, repo: "acme/frontend", branch: "uat" };
    insertBuildComponent(db, projectId, { name: "web", isWeb: true, position: 0, source: src });
    insertBuildComponent(db, projectId, { name: "web-uat", isWeb: true, position: 1, source: src });
    const deploymentId = insertDeployment(db, projectId);
    const { deps, rec } = makeDeps(db, null);

    const out = await runComposePipeline(
      deps,
      makeJob(projectId, deploymentId),
      { ...GITHUB_PAYLOAD, source: { type: "images" as const } },
      new AbortController().signal,
    );
    expect(out.outcome).toBe("done");
    expect(rec.clones).toHaveLength(1);
    expect(rec.builds).toHaveLength(2);
    db.close();
  });

  test("installation ไม่ active → deployment ล้มเหลว ไม่ clone", async () => {
    const db = makeDb();
    const projectId = insertProject(db);
    const inst = insertInstallation(db, 222, "suspended");
    insertBuildComponent(db, projectId, {
      name: "web",
      isWeb: true,
      position: 0,
      source: { installationRowId: inst, repo: "acme/frontend", branch: "uat" },
    });
    const deploymentId = insertDeployment(db, projectId);
    const { deps, rec } = makeDeps(db, null);

    const out = await runComposePipeline(
      deps,
      makeJob(projectId, deploymentId),
      { ...GITHUB_PAYLOAD, source: { type: "images" as const } },
      new AbortController().signal,
    );
    expect(out.outcome).toBe("failed");
    expect(rec.clones).toHaveLength(0);
    const row = db
      .query<{ status: string; failure_code: string }, [string]>(
        "SELECT status, failure_code FROM deployments WHERE id = ?",
      )
      .get(deploymentId);
    expect(row).toEqual({ status: "failed", failure_code: "CLONE_FAILED" });
    db.close();
  });
});

describe("runComposePipeline — build arg/secret ต่อ component (0.1.25)", () => {
  test("secret ไปเป็น --secret file (component ทับ project), build arg รวมกัน, ไฟล์ถูกลบหลัง build", async () => {
    const db = makeDb();
    const keys = await createMasterKeys(1, { 1: new Uint8Array(32).fill(0x42) });
    const projectId = insertProject(db);
    const api = insertBuildComponent(db, projectId, { name: "api", position: 0 });
    const web = insertBuildComponent(db, projectId, { name: "web", isWeb: true, position: 1 });

    await insertEnv(db, keys, projectId, {
      key: "NPM_TOKEN",
      value: "project-token",
      secret: true,
      scope: "build",
    });
    await insertEnv(db, keys, projectId, {
      key: "DEPLOY_ENV",
      value: "staging",
      secret: false,
      scope: "both",
    });
    await insertEnv(db, keys, projectId, {
      key: "NPM_TOKEN",
      value: "web-token",
      secret: true,
      scope: "build",
      componentId: web,
    });
    await insertEnv(db, keys, projectId, {
      key: "NUXT_PUBLIC_I18N_BASE_URL",
      value: "https://web.example.com",
      secret: false,
      scope: "build",
      componentId: web,
    });
    const deploymentId = insertDeployment(db, projectId);
    const { deps, rec } = makeDeps(db, keys);

    const out = await runComposePipeline(
      deps,
      makeJob(projectId, deploymentId),
      GITHUB_PAYLOAD,
      new AbortController().signal,
    );
    expect(out.outcome).toBe("done");

    const byId = new Map(rec.builds.map((b) => [b.labels["platform.component_id"], b]));
    const apiBuild = byId.get(api);
    const webBuild = byId.get(web);
    expect(apiBuild?.buildArgs).toEqual({ DEPLOY_ENV: "staging" });
    expect(apiBuild?.secretContents).toEqual({ NPM_TOKEN: "project-token" });
    expect(webBuild?.buildArgs).toEqual({
      DEPLOY_ENV: "staging",
      NUXT_PUBLIC_I18N_BASE_URL: "https://web.example.com",
    });
    expect(webBuild?.secretContents).toEqual({ NPM_TOKEN: "web-token" });
    // secret ห้ามโผล่ใน build arg
    expect(JSON.stringify(webBuild?.buildArgs)).not.toContain("token");
    // ไฟล์ secret ต้องถูกลบหลังจบ
    for (const b of rec.builds) {
      for (const s of b.secrets ?? []) expect(existsSync(s.sourcePath)).toBe(false);
    }
    db.close();
  });
});

describe("mergeBuildEnv", () => {
  const inj = (over: Partial<EnvInjection>): EnvInjection => ({
    runtimeEnv: {},
    buildArgs: {},
    buildSecretValues: [],
    secretValues: [],
    definedCount: 0,
    failedKeys: [],
    ...over,
  });

  test("component ตั้ง key เดียวกันเป็น arg ธรรมดา → ไม่เหลือเป็น secret (และกลับกัน)", () => {
    const base = inj({
      buildArgs: { A: "1" },
      buildSecretValues: [{ key: "B", value: "s" }],
    });
    const scoped = inj({
      buildArgs: { B: "plain" },
      buildSecretValues: [{ key: "A", value: "x" }],
    });
    expect(mergeBuildEnv(base, scoped)).toEqual({
      buildArgs: { B: "plain" },
      secrets: [{ key: "A", value: "x" }],
    });
  });

  test("ไม่มี component env → ใช้ของ project ตรง ๆ", () => {
    const base = inj({ buildArgs: { A: "1" }, buildSecretValues: [{ key: "B", value: "s" }] });
    expect(mergeBuildEnv(base, undefined)).toEqual({
      buildArgs: { A: "1" },
      secrets: [{ key: "B", value: "s" }],
    });
  });
});
