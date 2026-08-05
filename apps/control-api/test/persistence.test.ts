import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupDatabase,
  loadMigrations,
  migrateUp,
  migrationsDir,
  openDatabase,
  verifyBackup,
} from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { json } from "./helpers";

/**
 * ตรวจ Exit Criteria ของ Phase 1: "Restart ไม่ทำข้อมูลสูญหาย"
 *
 * ใช้ database บนดิสก์จริง แล้วปิด connection/สร้าง app ใหม่เพื่อจำลองการ restart
 * ของ Control API — ข้อมูลต้องอยู่ครบโดยไม่ต้อง migrate ซ้ำ
 */

const dirs: string[] = [];
const connections: { close: () => void }[] = [];

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "zixploy-persist-"));
  dirs.push(dir);
  return join(dir, "zixploy.sqlite");
}

afterEach(() => {
  for (const db of connections.splice(0)) db.close();
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        Bun.sleepSync(20);
      }
    }
  }
});

const PASSWORD = "correct horse battery staple";

/** เปิด "instance" ใหม่ของ Control API บน database เดิม — จำลอง process restart */
function bootInstance(dbPath: string) {
  const db = openDatabase({ path: dbPath });
  connections.push(db);
  const applied = migrateUp(db, loadMigrations(migrationsDir()));
  return { db, app: buildApp(db), applied };
}

function readCookies(res: Response) {
  const cookies: Record<string, string> = {};
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (pair && eq > 0) cookies[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  return {
    header: Object.entries(cookies)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("; "),
    csrf: cookies.zx_csrf ?? "",
  };
}

async function loginTo(app: ReturnType<typeof bootInstance>["app"]) {
  const res = await app.handle(
    new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: PASSWORD }),
    }),
  );
  expect(res.status).toBe(200);
  return readCookies(res);
}

describe("persistence ข้าม restart", () => {
  test("login -> create project -> restart -> session และ project ยังอยู่", async () => {
    const dbPath = tempDbPath();

    // --- instance ที่ 1
    const first = bootInstance(dbPath);
    expect(first.applied.length).toBeGreaterThan(0); // migrate จากฐานว่าง
    const now = Date.now();
    first.db
      .query(
        "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(ulid(), "admin", await hashPassword(PASSWORD), now, now);

    const auth = await loginTo(first.app);
    const created = await json(
      await first.app.handle(
        new Request("http://localhost/api/v1/projects", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: auth.header,
            "x-csrf-token": auth.csrf,
          },
          body: JSON.stringify({ name: "survives-restart" }),
        }),
      ),
    );
    expect(created.id).toBeString();

    // --- "restart": ปิด connection เดิมแล้วเปิด instance ใหม่บนไฟล์เดียวกัน
    first.db.close();
    const second = bootInstance(dbPath);
    // ไม่ต้อง migrate ซ้ำ
    expect(second.applied).toEqual([]);

    // session cookie เดิมยังใช้ได้ — ไม่ต้อง login ใหม่
    const sessionRes = await json(
      await second.app.handle(
        new Request("http://localhost/api/v1/auth/session", {
          headers: { cookie: auth.header },
        }),
      ),
    );
    expect(sessionRes).toMatchObject({ authenticated: true, username: "admin" });

    // project ยังอยู่พร้อมค่าเดิมทุก field
    const fetched = await json(
      await second.app.handle(
        new Request(`http://localhost/api/v1/projects/${created.id}`, {
          headers: { cookie: auth.header },
        }),
      ),
    );
    expect(fetched).toEqual(created);

    // และยังอยู่ใน list ด้วย
    const list = await json(
      await second.app.handle(
        new Request("http://localhost/api/v1/projects", { headers: { cookie: auth.header } }),
      ),
    );
    expect(list.items).toHaveLength(1);
    expect(list.items[0].name).toBe("survives-restart");
  });

  test("การแก้ไขก่อน restart ถูกบันทึกลงดิสก์จริง", async () => {
    const dbPath = tempDbPath();
    const first = bootInstance(dbPath);
    const now = Date.now();
    first.db
      .query(
        "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(ulid(), "admin", await hashPassword(PASSWORD), now, now);

    const auth = await loginTo(first.app);
    const created = await json(
      await first.app.handle(
        new Request("http://localhost/api/v1/projects", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: auth.header,
            "x-csrf-token": auth.csrf,
          },
          body: JSON.stringify({ name: "before" }),
        }),
      ),
    );

    await first.app.handle(
      new Request(`http://localhost/api/v1/projects/${created.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          cookie: auth.header,
          "x-csrf-token": auth.csrf,
        },
        body: JSON.stringify({ name: "after", internalPort: 8080, autoDeploy: true }),
      }),
    );

    first.db.close();
    const second = bootInstance(dbPath);
    const fetched = await json(
      await second.app.handle(
        new Request(`http://localhost/api/v1/projects/${created.id}`, {
          headers: { cookie: auth.header },
        }),
      ),
    );
    expect(fetched.name).toBe("after");
    expect(fetched.internalPort).toBe(8080);
    expect(fetched.autoDeploy).toBe(true);
  });
});

describe("backup แล้ว restore ลง database ใหม่", () => {
  test("integrity ผ่านและข้อมูลสำคัญครบ ใช้งาน API ต่อได้ทันที", async () => {
    const dbPath = tempDbPath();
    const source = bootInstance(dbPath);
    const now = Date.now();
    source.db
      .query(
        "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(ulid(), "admin", await hashPassword(PASSWORD), now, now);

    const auth = await loginTo(source.app);
    for (const name of ["alpha", "beta"]) {
      await source.app.handle(
        new Request("http://localhost/api/v1/projects", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: auth.header,
            "x-csrf-token": auth.csrf,
          },
          body: JSON.stringify({ name }),
        }),
      );
    }

    // --- backup
    const backupPath = `${dbPath}.backup`;
    backupDatabase(source.db, backupPath);
    expect(verifyBackup(backupPath)).toBe(true);

    // --- restore: ใช้ไฟล์ backup เป็น database ของ instance ใหม่
    const restored = bootInstance(backupPath);
    expect(restored.applied).toEqual([]); // schema ติดมากับ backup แล้ว

    // login ด้วย credentials เดิมได้ = users/password hash ถูก restore ครบ
    const restoredAuth = await loginTo(restored.app);

    const list = await json(
      await restored.app.handle(
        new Request("http://localhost/api/v1/projects", {
          headers: { cookie: restoredAuth.header },
        }),
      ),
    );
    expect(list.items.map((p: { name: string }) => p.name).sort()).toEqual(["alpha", "beta"]);

    // เขียนต่อลง instance ที่ restore มาได้
    const createdAfterRestore = await restored.app.handle(
      new Request("http://localhost/api/v1/projects", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: restoredAuth.header,
          "x-csrf-token": restoredAuth.csrf,
        },
        body: JSON.stringify({ name: "gamma" }),
      }),
    );
    expect(createdAfterRestore.status).toBe(201);
  });
});
