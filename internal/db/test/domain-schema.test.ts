/**
 * Migration 0008 (project_domains) — schema-level constraint tests
 * ทดสอบ DDL โดยตรงผ่าน raw SQL ไม่มี app code ที่ milestone นี้
 */
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/connection";
import { loadMigrations, migrateUp } from "../src/migrate";
import { migrationsDir } from "../src/paths";

const PROJECT_ID = "01JDOMAINPROJ00000000000001";
const D1 = "01JDOMAIN00000000000000001";
const D2 = "01JDOMAIN00000000000000002";
const D3 = "01JDOMAIN00000000000000003";

function setup() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));

  const now = Date.now();
  db.query(
    `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'domain-test', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(PROJECT_ID, now, now);

  return { db, now };
}

describe("migration 0008 — project_domains", () => {
  test("insert พื้นฐานสำเร็จและ defaults ถูกต้อง", () => {
    const { db, now } = setup();
    db.query(
      `INSERT INTO project_domains (id, project_id, hostname, internal_port, created_at, updated_at)
       VALUES (?, ?, 'example.com', 3000, ?, ?)`,
    ).run(D1, PROJECT_ID, now, now);

    const row = db
      .query<
        {
          https_enabled: number;
          redirect_http: number;
          redirect_mode: string;
          dns_status: string;
          enabled: number;
        },
        [string]
      >(
        "SELECT https_enabled, redirect_http, redirect_mode, dns_status, enabled FROM project_domains WHERE id = ?",
      )
      .get(D1);

    expect(row?.https_enabled).toBe(1);
    expect(row?.redirect_http).toBe(1);
    expect(row?.redirect_mode).toBe("none");
    expect(row?.dns_status).toBe("pending");
    expect(row?.enabled).toBe(1);
  });

  test("hostname UNIQUE — ซ้ำทั้งระบบถูกปฏิเสธ", () => {
    const { db, now } = setup();
    db.query(
      `INSERT INTO project_domains (id, project_id, hostname, internal_port, created_at, updated_at)
       VALUES (?, ?, 'clash.example.com', 3000, ?, ?)`,
    ).run(D1, PROJECT_ID, now, now);

    expect(() => {
      db.query(
        `INSERT INTO project_domains (id, project_id, hostname, internal_port, created_at, updated_at)
         VALUES (?, ?, 'clash.example.com', 4000, ?, ?)`,
      ).run(D2, PROJECT_ID, now, now);
    }).toThrow(/UNIQUE constraint/i);
  });

  test("redirect_mode ต้องเป็น none | www_to_root | root_to_www เท่านั้น", () => {
    const { db, now } = setup();
    expect(() => {
      db.query(
        `INSERT INTO project_domains (id, project_id, hostname, internal_port, redirect_mode, created_at, updated_at)
         VALUES (?, ?, 'a.example.com', 3000, 'invalid', ?, ?)`,
      ).run(D1, PROJECT_ID, now, now);
    }).toThrow();
  });

  test("redirect_mode='www_to_root' และ 'root_to_www' ใช้ได้", () => {
    const { db, now } = setup();
    db.query(
      `INSERT INTO project_domains (id, project_id, hostname, internal_port, redirect_mode, created_at, updated_at)
       VALUES (?, ?, 'www.foo.com', 3000, 'www_to_root', ?, ?)`,
    ).run(D1, PROJECT_ID, now, now);
    db.query(
      `INSERT INTO project_domains (id, project_id, hostname, internal_port, redirect_mode, created_at, updated_at)
       VALUES (?, ?, 'foo.com', 3000, 'root_to_www', ?, ?)`,
    ).run(D2, PROJECT_ID, now, now);

    const count = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) as n FROM project_domains WHERE project_id = ?",
      )
      .get(PROJECT_ID)!.n;
    expect(count).toBe(2);
  });

  test("dns_status ต้องเป็น pending | valid | mismatch | unknown เท่านั้น", () => {
    const { db, now } = setup();
    expect(() => {
      db.query(
        `INSERT INTO project_domains (id, project_id, hostname, internal_port, dns_status, created_at, updated_at)
         VALUES (?, ?, 'b.example.com', 3000, 'bad_status', ?, ?)`,
      ).run(D1, PROJECT_ID, now, now);
    }).toThrow();
  });

  test("https_enabled และ enabled ต้องเป็น 0 หรือ 1 เท่านั้น", () => {
    const { db, now } = setup();
    expect(() => {
      db.query(
        `INSERT INTO project_domains (id, project_id, hostname, internal_port, https_enabled, created_at, updated_at)
         VALUES (?, ?, 'c.example.com', 3000, 2, ?, ?)`,
      ).run(D1, PROJECT_ID, now, now);
    }).toThrow();
  });

  test("internal_port ต้องอยู่ระหว่าง 1–65535", () => {
    const { db, now } = setup();
    expect(() => {
      db.query(
        `INSERT INTO project_domains (id, project_id, hostname, internal_port, created_at, updated_at)
         VALUES (?, ?, 'd.example.com', 0, ?, ?)`,
      ).run(D1, PROJECT_ID, now, now);
    }).toThrow();
    expect(() => {
      db.query(
        `INSERT INTO project_domains (id, project_id, hostname, internal_port, created_at, updated_at)
         VALUES (?, ?, 'e.example.com', 65536, ?, ?)`,
      ).run(D2, PROJECT_ID, now, now);
    }).toThrow();
  });

  test("project_id FK enforced — project ไม่มีอยู่จริง → throw", () => {
    const { db, now } = setup();
    expect(() => {
      db.query(
        `INSERT INTO project_domains (id, project_id, hostname, internal_port, created_at, updated_at)
         VALUES (?, 'nonexistent', 'f.example.com', 3000, ?, ?)`,
      ).run(D1, now, now);
    }).toThrow();
  });

  test("ON DELETE CASCADE — ลบ project แล้ว domains หายไปด้วย", () => {
    const { db, now } = setup();
    db.query(
      `INSERT INTO project_domains (id, project_id, hostname, internal_port, created_at, updated_at)
       VALUES (?, ?, 'cascade.example.com', 3000, ?, ?)`,
    ).run(D1, PROJECT_ID, now, now);
    db.query(
      `INSERT INTO project_domains (id, project_id, hostname, internal_port, created_at, updated_at)
       VALUES (?, ?, 'cascade2.example.com', 3000, ?, ?)`,
    ).run(D2, PROJECT_ID, now, now);

    // ลบ project
    db.query("DELETE FROM projects WHERE id = ?").run(PROJECT_ID);

    const count = db
      .query<{ n: number }, []>("SELECT COUNT(*) as n FROM project_domains")
      .get()!.n;
    expect(count).toBe(0);
  });

  test("domain เดียวกัน project ต่างกัน — ไม่ได้ เพราะ hostname UNIQUE ทั้งระบบ", () => {
    const { db, now } = setup();
    // สร้าง project 2
    const projectId2 = "01JDOMAINPROJ00000000000002";
    db.query(
      `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
       VALUES (?, 'domain-test-2', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
    ).run(projectId2, now, now);

    db.query(
      `INSERT INTO project_domains (id, project_id, hostname, internal_port, created_at, updated_at)
       VALUES (?, ?, 'shared.example.com', 3000, ?, ?)`,
    ).run(D1, PROJECT_ID, now, now);

    // hostname ซ้ำ — ต้อง throw แม้ต่าง project
    expect(() => {
      db.query(
        `INSERT INTO project_domains (id, project_id, hostname, internal_port, created_at, updated_at)
         VALUES (?, ?, 'shared.example.com', 4000, ?, ?)`,
      ).run(D2, projectId2, now, now);
    }).toThrow(/UNIQUE constraint/i);
  });

  test("หลาย domain ต่อ project เดียวกัน — ทำได้ตราบที่ hostname ต่างกัน", () => {
    const { db, now } = setup();
    db.query(
      `INSERT INTO project_domains (id, project_id, hostname, internal_port, created_at, updated_at)
       VALUES (?, ?, 'app1.example.com', 3000, ?, ?)`,
    ).run(D1, PROJECT_ID, now, now);
    db.query(
      `INSERT INTO project_domains (id, project_id, hostname, internal_port, created_at, updated_at)
       VALUES (?, ?, 'app2.example.com', 3000, ?, ?)`,
    ).run(D2, PROJECT_ID, now, now);
    db.query(
      `INSERT INTO project_domains (id, project_id, hostname, internal_port, created_at, updated_at)
       VALUES (?, ?, 'app3.example.com', 3000, ?, ?)`,
    ).run(D3, PROJECT_ID, now, now);

    const count = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) as n FROM project_domains WHERE project_id = ?",
      )
      .get(PROJECT_ID)!.n;
    expect(count).toBe(3);
  });

  test("idx_project_domains_project_id index ถูกสร้าง", () => {
    const { db } = setup();
    const row = db
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name=?",
      )
      .get("idx_project_domains_project_id");
    expect(row?.name).toBe("idx_project_domains_project_id");
  });
});
