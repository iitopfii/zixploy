/**
 * Migration 0034 (projects.link_network) — schema-level tests
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateDown, migrateUp, migrationsDir, openDatabase } from "../src";

const all = loadMigrations(migrationsDir());
const through0034 = all.filter((m) => m.version <= "0034");

function setup() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, through0034);
  db.query(
    `INSERT INTO projects (id, name, status, mode, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES ('p1', 'p', 'new', 'compose', 'Dockerfile', '.', 'unless-stopped', 900, 1, 1)`,
  ).run();
  return db;
}

const setLink = (db: ReturnType<typeof setup>, v: string | null) =>
  db.query("UPDATE projects SET link_network = ? WHERE id = 'p1'").run(v);

describe("0034 projects.link_network", () => {
  test("ค่าเริ่มต้น NULL และรับชื่อที่ถูกรูปแบบ", () => {
    const db = setup();
    expect(
      db.query<{ link_network: string | null }, []>("SELECT link_network FROM projects").get(),
    ).toEqual({ link_network: null });
    for (const ok of ["sealand", "a", "s-1", "0abc", "a".repeat(40)]) {
      expect(() => setLink(db, ok)).not.toThrow();
    }
  });

  test("ปฏิเสธรูปแบบผิด", () => {
    const db = setup();
    for (const bad of ["", "Sealand", "-x", "a_b", "a b", "a.b", "a".repeat(41)]) {
      expect(() => setLink(db, bad)).toThrow();
    }
  });

  test("rollback ลบคอลัมน์ได้", () => {
    const db = setup();
    setLink(db, "sealand");
    migrateDown(db, through0034, 1);
    const cols = db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('projects')")
      .all()
      .map((c) => c.name);
    expect(cols).not.toContain("link_network");
  });
});
