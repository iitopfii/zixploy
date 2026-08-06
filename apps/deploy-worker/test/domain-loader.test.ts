/**
 * loadProjectDomains — unit tests (docs/phase-05-domains.md M4)
 *
 * ครอบคลุม:
 * - ไม่มี domain → คืน []
 * - คืนเฉพาะ enabled=1
 * - คืน DomainConfig ครบฟิลด์
 * - domain ของ project อื่นไม่รั่วมา
 * - ครบทั้ง 3 redirect modes
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { loadProjectDomains } from "../src/domains/loader";

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function insertProject(db: ReturnType<typeof makeDb>): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO projects
      (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'test', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(id, now, now);
  return id;
}

function insertDomain(
  db: ReturnType<typeof makeDb>,
  projectId: string,
  opts: {
    hostname: string;
    internalPort?: number;
    httpsEnabled?: boolean;
    redirectHttp?: boolean;
    redirectMode?: "none" | "www_to_root" | "root_to_www";
    enabled?: boolean;
  },
) {
  const now = Date.now();
  db.query(
    `INSERT INTO project_domains
      (id, project_id, hostname, internal_port, https_enabled, redirect_http, redirect_mode, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ulid(),
    projectId,
    opts.hostname,
    opts.internalPort ?? 3000,
    opts.httpsEnabled !== false ? 1 : 0,
    opts.redirectHttp !== false ? 1 : 0,
    opts.redirectMode ?? "none",
    opts.enabled !== false ? 1 : 0,
    now,
    now,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadProjectDomains — ไม่มี domain", () => {
  test("คืน [] เมื่อไม่มี domain", () => {
    const db = makeDb();
    const projectId = insertProject(db);
    expect(loadProjectDomains(db, projectId)).toEqual([]);
  });
});

describe("loadProjectDomains — enabled filter", () => {
  test("คืนเฉพาะ domain ที่ enabled=1", () => {
    const db = makeDb();
    const projectId = insertProject(db);

    insertDomain(db, projectId, { hostname: "enabled.example.com", enabled: true });
    insertDomain(db, projectId, { hostname: "disabled.example.com", enabled: false });

    const domains = loadProjectDomains(db, projectId);
    expect(domains).toHaveLength(1);
    expect(domains[0]!.hostname).toBe("enabled.example.com");
  });
});

describe("loadProjectDomains — ครบฟิลด์", () => {
  test("map ฟิลด์ครบถ้วน", () => {
    const db = makeDb();
    const projectId = insertProject(db);

    insertDomain(db, projectId, {
      hostname: "example.com",
      internalPort: 8080,
      httpsEnabled: true,
      redirectHttp: true,
      redirectMode: "none",
    });

    const domains = loadProjectDomains(db, projectId);
    expect(domains).toHaveLength(1);

    const d = domains[0]!;
    expect(d.hostname).toBe("example.com");
    expect(d.internalPort).toBe(8080);
    expect(d.httpsEnabled).toBe(true);
    expect(d.redirectHttp).toBe(true);
    expect(d.redirectMode).toBe("none");
  });

  test("httpsEnabled=false, redirectHttp=false, redirectMode=www_to_root", () => {
    const db = makeDb();
    const projectId = insertProject(db);

    insertDomain(db, projectId, {
      hostname: "example.com",
      internalPort: 3000,
      httpsEnabled: false,
      redirectHttp: false,
      redirectMode: "www_to_root",
    });

    const d = loadProjectDomains(db, projectId)[0]!;
    expect(d.httpsEnabled).toBe(false);
    expect(d.redirectHttp).toBe(false);
    expect(d.redirectMode).toBe("www_to_root");
  });

  test("redirect_mode='root_to_www'", () => {
    const db = makeDb();
    const projectId = insertProject(db);

    insertDomain(db, projectId, { hostname: "example.com", redirectMode: "root_to_www" });

    const d = loadProjectDomains(db, projectId)[0]!;
    expect(d.redirectMode).toBe("root_to_www");
  });
});

describe("loadProjectDomains — isolation between projects", () => {
  test("domain ของ project อื่นไม่รั่วมา", () => {
    const db = makeDb();
    const projectA = insertProject(db);
    const projectB = insertProject(db);

    insertDomain(db, projectA, { hostname: "a.example.com" });
    insertDomain(db, projectB, { hostname: "b.example.com" });

    const domainsA = loadProjectDomains(db, projectA);
    expect(domainsA).toHaveLength(1);
    expect(domainsA[0]!.hostname).toBe("a.example.com");

    const domainsB = loadProjectDomains(db, projectB);
    expect(domainsB).toHaveLength(1);
    expect(domainsB[0]!.hostname).toBe("b.example.com");
  });
});

describe("loadProjectDomains — หลาย domain", () => {
  test("คืนทุก domain ที่ enabled เรียงตาม created_at", () => {
    const db = makeDb();
    const projectId = insertProject(db);

    // insert ทีละ ms เพื่อ created_at ต่างกัน
    for (let i = 0; i < 3; i++) {
      insertDomain(db, projectId, { hostname: `domain${i}.example.com` });
    }

    const domains = loadProjectDomains(db, projectId);
    expect(domains).toHaveLength(3);
    // ตรวจ order ไม่ผิด
    for (let i = 0; i < 3; i++) {
      expect(domains[i]!.hostname).toBe(`domain${i}.example.com`);
    }
  });
});
