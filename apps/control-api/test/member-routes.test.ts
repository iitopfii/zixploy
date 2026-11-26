import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { type Access, requiredAccess } from "../src/auth/policy";
import { json } from "./helpers";

const PASSWORD = "correct horse battery staple";

type Call = (path: string, init?: RequestInit) => Promise<Response>;

async function addUser(db: Database, username: string, role: string): Promise<string> {
  const id = ulid();
  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, username, await hashPassword(PASSWORD), role, now, now);
  return id;
}

function addProject(db: Database, name: string): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    "INSERT INTO projects (id, name, status, created_at, updated_at) VALUES (?, ?, 'new', ?, ?)",
  ).run(id, name, now, now);
  return id;
}

function addMember(db: Database, projectId: string, userId: string): void {
  db.query("INSERT INTO project_members (project_id, user_id, created_at) VALUES (?, ?, ?)").run(
    projectId,
    userId,
    Date.now(),
  );
}

async function loginAs(app: ReturnType<typeof buildApp>, username: string): Promise<Call> {
  const res = await app.handle(
    new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: PASSWORD }),
    }),
  );
  expect(res.status).toBe(200);
  const cookies: Record<string, string> = {};
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (pair && eq > 0) cookies[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
  return (path, init = {}) =>
    app.handle(
      new Request(`http://localhost/api/v1${path}`, {
        ...init,
        headers: {
          cookie,
          "x-csrf-token": cookies.zx_csrf ?? "",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      }),
    );
}

async function setup() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  const adminId = await addUser(db, "admin", "admin");
  const devId = await addUser(db, "dev", "developer");
  const viewerId = await addUser(db, "viewer", "viewer");
  const mine = addProject(db, "mine");
  const other = addProject(db, "other");
  addMember(db, mine, devId);
  addMember(db, mine, viewerId);
  const app = buildApp(db);
  return {
    db,
    app,
    adminId,
    devId,
    viewerId,
    mine,
    other,
    admin: await loginAs(app, "admin"),
    dev: await loginAs(app, "dev"),
    viewer: await loginAs(app, "viewer"),
  };
}

const body = (value: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(value) });
const patch = (value: unknown): RequestInit => ({ method: "PATCH", body: JSON.stringify(value) });

describe("requiredAccess — นโยบายกลาง", () => {
  test("route ที่ไม่รู้จักตกไปที่ admin (fail-closed)", () => {
    expect(requiredAccess("GET", "/api/v1/something-new")).toEqual({ kind: "role", min: "admin" });
    expect(requiredAccess("GET", "/elsewhere")).toEqual({ kind: "role", min: "admin" });
  });

  test("โปรเจกต์: GET = อ่าน, อื่น ๆ = เขียน, members/archive = admin", () => {
    expect(requiredAccess("GET", "/api/v1/projects/P1/domains")).toEqual({
      kind: "project",
      projectId: "P1",
      write: false,
    });
    expect(requiredAccess("POST", "/api/v1/projects/P1/deploy")).toEqual({
      kind: "project",
      projectId: "P1",
      write: true,
    });
    expect(requiredAccess("POST", "/api/v1/projects/P1/archive")).toEqual({
      kind: "role",
      min: "admin",
    });
    expect(requiredAccess("POST", "/api/v1/projects")).toEqual({ kind: "role", min: "admin" });
    expect(requiredAccess("GET", "/api/v1/projects/")).toEqual({ kind: "authenticated" });
  });

  test("path ที่เข้ารหัสตัวอักษรไม่หลบกฎของ segment", () => {
    expect(requiredAccess("POST", "/api/v1/projects/P1/%61rchive")).toEqual({
      kind: "role",
      min: "admin",
    });
    expect(requiredAccess("GET", "/api/v1/projects/P1/%zz")).toEqual({
      kind: "role",
      min: "admin",
    });
  });

  test("ของระบบเป็น admin ยกเว้นรายการที่ developer ต้องใช้", () => {
    const admin: Access = { kind: "role", min: "admin" };
    const developer: Access = { kind: "role", min: "developer" };
    expect(requiredAccess("GET", "/api/v1/services")).toEqual(developer);
    expect(requiredAccess("GET", "/api/v1/services/S1/credentials")).toEqual(admin);
    expect(requiredAccess("POST", "/api/v1/services")).toEqual(admin);
    expect(requiredAccess("GET", "/api/v1/registries")).toEqual(developer);
    expect(requiredAccess("DELETE", "/api/v1/registries/R1")).toEqual(admin);
    expect(requiredAccess("GET", "/api/v1/github/branches")).toEqual(developer);
    expect(requiredAccess("GET", "/api/v1/github/apps/A1/install-url")).toEqual(admin);
    expect(requiredAccess("GET", "/api/v1/system/settings")).toEqual(admin);
    expect(requiredAccess("GET", "/api/v1/system/version")).toEqual({ kind: "authenticated" });
    expect(requiredAccess("GET", "/api/v1/audit-events")).toEqual(admin);
    expect(requiredAccess("GET", "/api/v1/members")).toEqual(admin);
  });
});

describe("สิทธิ์ตาม role และสมาชิกโปรเจกต์", () => {
  test("session บอก role และ userId", async () => {
    const { dev, devId } = await setup();
    const session = await json(await dev("/auth/session"));
    expect(session).toMatchObject({ authenticated: true, username: "dev", role: "developer" });
    expect(session.userId).toBe(devId);
  });

  test("รายการโปรเจกต์: admin เห็นทั้งหมด, สมาชิกเห็นเฉพาะของตัวเอง", async () => {
    const { admin, dev, viewer, mine } = await setup();
    expect((await json(await admin("/projects"))).items).toHaveLength(2);
    for (const call of [dev, viewer]) {
      const items = (await json(await call("/projects"))).items;
      expect(items.map((p: { id: string }) => p.id)).toEqual([mine]);
    }
  });

  test("โปรเจกต์ที่ไม่ใช่สมาชิกตอบ 404 เหมือนไม่มีอยู่", async () => {
    const { dev, viewer, other } = await setup();
    for (const call of [dev, viewer]) {
      const res = await call(`/projects/${other}`);
      expect(res.status).toBe(404);
      expect((await json(res)).error.code).toBe("PROJECT_NOT_FOUND");
    }
    expect((await dev(`/projects/${other}`, patch({ name: "x" }))).status).toBe(404);
    expect((await dev(`/projects/${other}/domains`)).status).toBe(404);
  });

  test("viewer อ่านได้ แก้ไม่ได้ · developer แก้ได้", async () => {
    const { dev, viewer, mine } = await setup();
    expect((await viewer(`/projects/${mine}`)).status).toBe(200);
    expect((await viewer(`/projects/${mine}/domains`)).status).toBe(200);

    const denied = await viewer(`/projects/${mine}`, patch({ name: "renamed" }));
    expect(denied.status).toBe(403);
    expect((await json(denied)).error.code).toBe("FORBIDDEN");

    const ok = await dev(`/projects/${mine}`, patch({ name: "renamed" }));
    expect(ok.status).toBe(200);
    expect((await json(ok)).name).toBe("renamed");
  });

  test("สร้างและ archive โปรเจกต์ = admin เท่านั้น", async () => {
    const { admin, dev, mine } = await setup();
    expect((await dev("/projects", body({ name: "new" }))).status).toBe(403);
    expect((await dev(`/projects/${mine}/archive`, { method: "POST" })).status).toBe(403);
    expect((await admin("/projects", body({ name: "new" }))).status).toBe(201);
  });

  test("ส่วนของระบบ: developer/viewer เข้าไม่ได้", async () => {
    const { dev, viewer } = await setup();
    for (const path of ["/members", "/audit-events", "/system/settings", "/system/metrics"]) {
      for (const call of [dev, viewer]) {
        const res = await call(path);
        expect(res.status).toBe(403);
        expect((await json(res)).error.code).toBe("FORBIDDEN");
      }
    }
    expect((await dev("/services")).status).toBe(200);
    expect((await viewer("/services")).status).toBe(403);
    expect((await dev("/services", body({ type: "postgres", name: "x" }))).status).toBe(403);
  });

  test("ฟิลด์ที่ข้ามขอบเขตโปรเจกต์สงวนไว้ให้ admin", async () => {
    const { dev, mine } = await setup();
    const link = await dev(`/projects/${mine}`, patch({ linkNetwork: "shared" }));
    expect(link.status).toBe(403);

    const bind = await dev(
      `/projects/${mine}/volumes`,
      body({ displayName: "data", mountPath: "/data", hostPath: "/srv/data" }),
    );
    expect(bind.status).toBe(403);

    const ref = await dev(
      `/projects/${mine}/components`,
      body({ name: "db", sourceKind: "managed_ref", managedServiceId: ulid() }),
    );
    expect(ref.status).toBe(403);
  });

  test("deployment: หาโปรเจกต์จาก deployment แล้วตรวจสมาชิก", async () => {
    const { db, dev, viewer, admin, other, mine } = await setup();
    const insert = (projectId: string) => {
      const id = ulid();
      const now = Date.now();
      db.query(
        `INSERT INTO deployments (id, project_id, status, trigger, commit_sha, queued_at, created_at, updated_at)
         VALUES (?, ?, 'succeeded', 'push', 'abc123', ?, ?, ?)`,
      ).run(id, projectId, now, now, now);
      return id;
    };
    const mineDep = insert(mine);
    const otherDep = insert(other);

    expect((await viewer(`/deployments/${mineDep}`)).status).toBe(200);
    expect((await dev(`/deployments/${otherDep}`)).status).toBe(404);
    expect((await admin(`/deployments/${otherDep}`)).status).toBe(200);
    expect((await viewer(`/deployments/${mineDep}/logs`)).status).toBe(200);
    expect((await dev(`/deployments/${otherDep}/logs`)).status).toBe(404);
    expect((await viewer(`/deployments/${mineDep}/cancel`, { method: "POST" })).status).toBe(403);
    expect((await dev(`/deployments/${otherDep}/cancel`, { method: "POST" })).status).toBe(404);
  });
});

describe("จัดการสมาชิก", () => {
  test("เพิ่มสมาชิก → login ได้ และเห็นเฉพาะโปรเจกต์ที่ให้", async () => {
    const { app, admin, mine } = await setup();
    const res = await admin(
      "/members",
      body({ username: "alice", password: PASSWORD, role: "viewer", projectIds: [mine] }),
    );
    expect(res.status).toBe(201);
    const created = await json(res);
    expect(created).toMatchObject({
      username: "alice",
      role: "viewer",
      disabled: false,
      projectIds: [mine],
    });
    expect(JSON.stringify(created)).not.toContain("password");

    const alice = await loginAs(app, "alice");
    expect((await json(await alice("/projects"))).items).toHaveLength(1);

    const list = (await json(await admin("/members"))).items;
    expect(list.map((m: { username: string }) => m.username).sort()).toEqual([
      "admin",
      "alice",
      "dev",
      "viewer",
    ]);
  });

  test("username ซ้ำ, role ผิด, project ไม่มีจริง → 400", async () => {
    const { admin } = await setup();
    const dup = await admin(
      "/members",
      body({ username: "dev", password: PASSWORD, role: "viewer" }),
    );
    expect(dup.status).toBe(400);
    expect((await json(dup)).error.details.field).toBe("username");

    const badRole = await admin(
      "/members",
      body({ username: "bob", password: PASSWORD, role: "owner" }),
    );
    expect(badRole.status).toBe(400);

    const badProject = await admin(
      "/members",
      body({ username: "bob", password: PASSWORD, role: "viewer", projectIds: [ulid()] }),
    );
    expect(badProject.status).toBe(400);
    expect((await json(badProject)).error.details.field).toBe("projectIds");
  });

  test("เปลี่ยน role มีผลกับ session ที่เปิดอยู่ทันที", async () => {
    const { admin, viewer, viewerId, mine } = await setup();
    expect((await viewer(`/projects/${mine}`, patch({ name: "a" }))).status).toBe(403);
    expect((await admin(`/members/${viewerId}`, patch({ role: "developer" }))).status).toBe(200);
    expect((await viewer(`/projects/${mine}`, patch({ name: "a" }))).status).toBe(200);
  });

  test("เปลี่ยนโปรเจกต์ของสมาชิก", async () => {
    const { admin, dev, devId, mine, other } = await setup();
    const res = await admin(`/members/${devId}`, patch({ projectIds: [other] }));
    expect((await json(res)).projectIds).toEqual([other]);
    expect((await dev(`/projects/${mine}`)).status).toBe(404);
    expect((await dev(`/projects/${other}`)).status).toBe(200);
  });

  test("ปิดบัญชี → session เดิมใช้ไม่ได้ และ login ไม่ได้", async () => {
    const { app, admin, dev, devId } = await setup();
    expect((await admin(`/members/${devId}`, patch({ disabled: true }))).status).toBe(200);
    expect((await dev("/projects")).status).toBe(401);

    const login = await app.handle(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "dev", password: PASSWORD }),
      }),
    );
    expect(login.status).toBe(401);
    expect((await json(login)).error.code).toBe("INVALID_CREDENTIALS");

    expect((await admin(`/members/${devId}`, patch({ disabled: false }))).status).toBe(200);
    await loginAs(app, "dev");
  });

  test("ตั้งรหัสผ่านใหม่ → session เดิมถูก revoke, รหัสใหม่ใช้ได้", async () => {
    const { app, admin, dev, devId } = await setup();
    const next = "another long password 42";
    expect((await admin(`/members/${devId}`, patch({ password: next }))).status).toBe(200);
    expect((await dev("/projects")).status).toBe(401);

    const login = await app.handle(
      new Request("http://localhost/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "dev", password: next }),
      }),
    );
    expect(login.status).toBe(200);
  });

  test("กันล็อกตัวเองออก: แก้ role/ปิด/ลบตัวเองไม่ได้ และต้องเหลือ admin", async () => {
    const { admin, adminId } = await setup();
    expect((await admin(`/members/${adminId}`, patch({ role: "viewer" }))).status).toBe(400);
    expect((await admin(`/members/${adminId}`, patch({ disabled: true }))).status).toBe(400);
    expect((await admin(`/members/${adminId}`, { method: "DELETE" })).status).toBe(400);
  });

  test("admin คนสุดท้ายลด role/ปิด/ลบไม่ได้ แม้ทำโดย admin อีกคนที่ถูกปิดไปแล้ว", async () => {
    const { db, app, admin, adminId } = await setup();
    const secondId = await addUser(db, "second", "admin");
    const second = await loginAs(app, "second");

    // มี admin 2 คน: second ลด role ของ admin ได้
    expect((await second(`/members/${adminId}`, patch({ role: "viewer" }))).status).toBe(200);
    // เหลือ second คนเดียว: admin (ตอนนี้ viewer) ทำอะไรไม่ได้ และ second ลดตัวเองไม่ได้
    expect((await admin(`/members/${secondId}`, patch({ role: "viewer" }))).status).toBe(403);
    expect((await second(`/members/${secondId}`, patch({ role: "viewer" }))).status).toBe(400);
  });

  test("ลบสมาชิก: audit log ยังบอกชื่อผู้ทำได้", async () => {
    const { db, admin, dev, devId, mine } = await setup();
    await dev(`/projects/${mine}`, patch({ name: "by-dev" }));
    const before = db
      .query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM audit_events WHERE actor_user_id = ?",
      )
      .get(devId);
    expect(before?.n).toBeGreaterThan(0);

    const res = await admin(`/members/${devId}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect((await dev("/projects")).status).toBe(401);

    const kept = db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM audit_events WHERE actor_username = 'dev' AND action = 'project_updated'",
      )
      .get();
    expect(kept?.n).toBe(1);
    const members = db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM project_members WHERE user_id = ?")
      .get(devId);
    expect(members?.n).toBe(0);
  });

  test("ไม่พบสมาชิก → 404", async () => {
    const { admin } = await setup();
    expect((await admin(`/members/${ulid()}`, patch({ role: "viewer" }))).status).toBe(404);
    expect((await admin("/members/not-an-id", { method: "DELETE" })).status).toBe(404);
  });
});
