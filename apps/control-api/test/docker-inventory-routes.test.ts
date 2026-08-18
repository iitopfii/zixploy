/**
 * GET /system/docker — Docker inventory (snapshot ที่ worker เขียน)
 *
 * ครอบคลุม: ต้อง auth (401), snapshot ว่าง → capturedAt null, คืนข้อมูลตามที่ worker เขียน
 * พร้อมเรียง running ก่อน, field mapping ครบ (managed boolean ฯลฯ)
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { json } from "./helpers";

async function login(app: ReturnType<typeof buildApp>) {
  const res = await app.handle(
    new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "adminpass123" }),
    }),
  );
  const cookies: Record<string, string> = {};
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (pair && eq > 0) cookies[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
}

async function setup() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)",
  ).run(ulid(), await hashPassword("adminpass123"), now, now);
  const app = buildApp(db, { masterKeys: null });
  const cookie = await login(app);
  return { db, app, cookie };
}

function get(app: ReturnType<typeof buildApp>, cookie?: string) {
  return app.handle(
    new Request("http://localhost/api/v1/system/docker", {
      headers: cookie ? { cookie } : {},
    }),
  );
}

describe("GET /system/docker", () => {
  test("ไม่ login → 401", async () => {
    const { app } = await setup();
    const res = await get(app);
    expect(res.status).toBe(401);
  });

  test("ยังไม่มี snapshot → capturedAt null + list ว่าง", async () => {
    const { app, cookie } = await setup();
    const body = await json(await get(app, cookie));
    expect(body.capturedAt).toBeNull();
    expect(body.containers).toEqual([]);
    expect(body.images).toEqual([]);
  });

  test("คืน snapshot ที่ worker เขียน — running ขึ้นก่อน + field mapping ครบ", async () => {
    const { db, app, cookie } = await setup();
    const ts = 1_700_000;
    const insertC = db.query(
      `INSERT INTO docker_containers
        (container_id, name, image, state, status, ports, networks, is_managed, created_text, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertC.run(
      "aaa",
      "stopped-app",
      "nginx:1",
      "exited",
      "Exited (0)",
      null,
      "bridge",
      0,
      null,
      ts,
    );
    insertC.run(
      "bbb",
      "live-app",
      "zixploy/x:1",
      "running",
      "Up 5 minutes",
      "80/tcp",
      "zixploy-proxy",
      1,
      "2026-08-13",
      ts,
    );
    db.query(
      `INSERT INTO docker_images (image_id, repository, tag, size, created_since, is_managed, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("img1", "redis", "7-alpine", "41MB", "3 weeks ago", 0, ts);

    const body = await json(await get(app, cookie));
    expect(body.capturedAt).toBe(ts);
    expect(body.containers).toHaveLength(2);
    // running ก่อน
    expect(body.containers[0].name).toBe("live-app");
    expect(body.containers[0].managed).toBe(true);
    expect(body.containers[0].ports).toBe("80/tcp");
    expect(body.containers[1].name).toBe("stopped-app");
    expect(body.containers[1].managed).toBe(false);
    expect(body.images[0]).toEqual({
      imageId: "img1",
      repository: "redis",
      tag: "7-alpine",
      size: "41MB",
      createdSince: "3 weeks ago",
      managed: false,
    });
  });
});
