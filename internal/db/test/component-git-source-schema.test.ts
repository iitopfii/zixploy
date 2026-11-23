/**
 * Migration 0033 (repo/branch ต่อ build component + deployments.component_commits) — schema-level tests
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateDown, migrateUp, migrationsDir, openDatabase } from "../src";

const all = loadMigrations(migrationsDir());
const through0033 = all.filter((m) => m.version <= "0033");

type Db = ReturnType<typeof openDatabase>;

function seed(db: Db): void {
  db.query(
    `INSERT INTO projects (id, name, status, mode, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES ('p1', 'p', 'new', 'compose', 'Dockerfile', '.', 'unless-stopped', 900, 1, 1)`,
  ).run();
}

function insertComponent(
  db: Db,
  id: string,
  kind: string,
  src: [string | null, string | null, string | null],
): void {
  db.query(
    `INSERT INTO project_components
       (id, project_id, name, role, source_kind, image_ref, repo_installation_id, repo_full_name, repo_branch,
        position, created_at, updated_at)
     VALUES (?, 'p1', ?, 'app', ?, ?, ?, ?, ?, 0, 1, 1)`,
  ).run(id, id, kind, kind === "image" ? "redis:7" : null, ...src);
}

describe("0033 — component git source", () => {
  test("ครบสามช่องหรือว่างทั้งหมด · ใช้ได้เฉพาะ build", () => {
    const db = openDatabase({ path: ":memory:" });
    migrateUp(db, all);
    seed(db);
    insertComponent(db, "c1", "build", ["inst", "acme/web", "main"]);
    insertComponent(db, "c2", "build", [null, null, null]);
    expect(() => insertComponent(db, "c3", "build", ["inst", "acme/web", null])).toThrow(/CHECK/);
    expect(() => insertComponent(db, "c4", "build", [null, "acme/web", "main"])).toThrow(/CHECK/);
    expect(() => insertComponent(db, "c5", "image", ["inst", "acme/web", "main"])).toThrow(/CHECK/);
  });

  test("component_commits ต้องเป็น JSON", () => {
    const db = openDatabase({ path: ":memory:" });
    migrateUp(db, all);
    seed(db);
    const ins = (commits: string | null) =>
      db
        .query(
          `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, component_commits, queued_at, created_at, updated_at)
           VALUES (lower(hex(randomblob(8))), 'p1', 'queued', 'manual', 'x', ?, 1, 1, 1)`,
        )
        .run(commits);
    ins(null);
    ins('{"c1":"abc"}');
    expect(() => ins("not json")).toThrow(/CHECK/);
  });

  test("rollback แล้ว up ใหม่ได้ ข้อมูลเดิมอยู่", () => {
    const db = openDatabase({ path: ":memory:" });
    migrateUp(db, through0033);
    seed(db);
    insertComponent(db, "c1", "build", ["inst", "acme/web", "main"]);
    migrateDown(db, through0033, 1);
    expect(db.query("SELECT id FROM project_components").all()).toEqual([{ id: "c1" }]);
    migrateUp(db, through0033);
    expect(db.query("SELECT repo_full_name FROM project_components WHERE id = 'c1'").get()).toEqual(
      { repo_full_name: null },
    );
  });
});
