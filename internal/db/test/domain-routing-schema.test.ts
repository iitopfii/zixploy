/**
 * Migration 0030 (project_domains: path_prefix + unique ต่อคู่ hostname/path) — schema-level tests
 *
 * rebuild ตาราง → ต้องไม่ทำข้อมูลเดิมหาย (รวม cert custom และ component_id) และ rollback ทิ้งเฉพาะแถว path
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateDown, migrateUp, migrationsDir, openDatabase } from "../src";

const all = loadMigrations(migrationsDir());
const before0030 = all.filter((m) => m.version < "0030");
const through0030 = all.filter((m) => m.version <= "0030");

type Db = ReturnType<typeof openDatabase>;

function seedProject(db: Db): void {
  db.query(
    `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES ('p1', 'p', 'new', 'Dockerfile', '.', 'unless-stopped', 900, 1, 1)`,
  ).run();
}

function insertDomain(db: Db, id: string, hostname: string, pathPrefix?: string): void {
  db.query(
    `INSERT INTO project_domains (id, project_id, hostname, ${pathPrefix ? "path_prefix, " : ""}internal_port, created_at, updated_at)
     VALUES (?, 'p1', ?, ${pathPrefix ? "?, " : ""}3000, 1, 1)`,
  ).run(...(pathPrefix ? [id, hostname, pathPrefix] : [id, hostname]));
}

describe("0030 — project_domains rebuild", () => {
  test("ข้อมูลเดิมอยู่ครบ (รวม cert custom) และ path_prefix เป็น NULL", () => {
    const db = openDatabase({ path: ":memory:" });
    migrateUp(db, before0030);
    seedProject(db);
    db.query(
      `INSERT INTO project_domains
         (id, project_id, hostname, internal_port, tls_mode, tls_cert_ciphertext, tls_key_ciphertext,
          tls_cert_fingerprint, created_at, updated_at)
       VALUES ('d1', 'p1', 'app.example.com', 3000, 'custom', x'01', x'02', 'fp', 1, 1)`,
    ).run();

    migrateUp(db, all);

    const row = db
      .query<
        {
          hostname: string;
          path_prefix: string | null;
          tls_mode: string;
          tls_cert_fingerprint: string;
        },
        []
      >(
        "SELECT hostname, path_prefix, tls_mode, tls_cert_fingerprint FROM project_domains WHERE id = 'd1'",
      )
      .get();
    expect(row).toEqual({
      hostname: "app.example.com",
      path_prefix: null,
      tls_mode: "custom",
      tls_cert_fingerprint: "fp",
    });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("hostname เดียวกันต่าง path ได้ แต่ทั้ง host ซ้ำหรือ path ซ้ำไม่ได้", () => {
    const db = openDatabase({ path: ":memory:" });
    migrateUp(db, all);
    seedProject(db);
    insertDomain(db, "d1", "app.example.com");
    insertDomain(db, "d2", "app.example.com", "/api/");
    expect(() => insertDomain(db, "d3", "app.example.com")).toThrow(/UNIQUE/);
    expect(() => insertDomain(db, "d4", "app.example.com", "/api/")).toThrow(/UNIQUE/);
  });

  test("CHECK: path ต้องเป็นรูป /x/ และ redirect www/root ใช้กับแถว path ไม่ได้", () => {
    const db = openDatabase({ path: ":memory:" });
    migrateUp(db, all);
    seedProject(db);
    expect(() => insertDomain(db, "d1", "a.example.com", "/api")).toThrow(/CHECK/);
    expect(() =>
      db
        .query(
          `INSERT INTO project_domains (id, project_id, hostname, path_prefix, redirect_mode, internal_port, created_at, updated_at)
           VALUES ('d2', 'p1', 'b.example.com', '/api/', 'www_to_root', 3000, 1, 1)`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  test("rollback ทิ้งเฉพาะแถว path ของเดิมอยู่ครบ", () => {
    const db = openDatabase({ path: ":memory:" });
    migrateUp(db, through0030);
    seedProject(db);
    insertDomain(db, "d1", "app.example.com");
    insertDomain(db, "d2", "app.example.com", "/api/");

    migrateDown(db, through0030, 1);

    expect(db.query("SELECT id FROM project_domains").all()).toEqual([{ id: "d1" }]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
