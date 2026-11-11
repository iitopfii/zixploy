/**
 * Registry credential routes (0.1.24)
 *
 * ครอบคลุม: CRUD, password ไม่หลุดออก API และถอดกลับได้ด้วย AAD เดียวกับ worker,
 * normalize host, ซ้ำ → 409, ไม่มี master key → 503, ต้อง login
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { decryptEnvelope } from "../src/crypto/envelope";
import { createMasterKeys } from "../src/crypto/master-key";
import { json } from "./helpers";

async function setup(opts: { withKeys?: boolean } = {}) {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)",
  ).run(ulid(), await hashPassword("adminpass123"), now, now);

  const masterKeys =
    (opts.withKeys ?? true)
      ? await createMasterKeys(1, { 1: new Uint8Array(32).fill(0x42) })
      : null;
  const app = buildApp(db, { masterKeys });

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
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");
  const csrf = cookies.zx_csrf ?? "";

  const call = (method: string, path: string, body?: unknown) =>
    app.handle(
      new Request(`http://localhost/api/v1/registries${path}`, {
        method,
        headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
  return { db, app, masterKeys, call };
}

const GHCR = { registry: "https://GHCR.io/", username: "deploy-bot", password: "ghp_secret123" };

describe("registry routes", () => {
  test("ต้อง login → 401", async () => {
    const { app } = await setup();
    const res = await app.handle(new Request("http://localhost/api/v1/registries"));
    expect(res.status).toBe(401);
  });

  test("POST → 201, normalize host, ไม่คืน password, ciphertext ถอดได้ด้วย AAD registry:<id>", async () => {
    const { db, masterKeys, call } = await setup();
    const res = await call("POST", "/", GHCR);
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.registry).toBe("ghcr.io");
    expect(body.username).toBe("deploy-bot");
    expect(JSON.stringify(body)).not.toContain("ghp_secret123");

    const list = await json(await call("GET", "/"));
    expect(JSON.stringify(list)).not.toContain("ghp_secret123");
    expect(list.registries).toHaveLength(1);

    const row = db
      .query<{ password_ciphertext: Uint8Array }, [string]>(
        "SELECT password_ciphertext FROM registry_credentials WHERE id = ?",
      )
      .get(body.id);
    if (!row || !masterKeys) throw new Error("ไม่มีแถวหรือ key");
    const plain = await decryptEnvelope(
      masterKeys,
      new Uint8Array(row.password_ciphertext),
      `registry:${body.id}`,
    );
    expect(plain).toBe("ghp_secret123");
  });

  test("host ซ้ำ → 409", async () => {
    const { call } = await setup();
    expect((await call("POST", "/", GHCR)).status).toBe(201);
    expect((await call("POST", "/", { ...GHCR, registry: "ghcr.io" })).status).toBe(409);
  });

  test("host มี path → 422", async () => {
    const { call } = await setup();
    expect((await call("POST", "/", { ...GHCR, registry: "ghcr.io/acme" })).status).toBe(422);
  });

  test("ไม่มี master key → 503", async () => {
    const { call } = await setup({ withKeys: false });
    expect((await call("POST", "/", GHCR)).status).toBe(503);
  });

  test("PATCH password → ciphertext เปลี่ยน, DELETE → หาย", async () => {
    const { db, masterKeys, call } = await setup();
    const created = await json(await call("POST", "/", GHCR));
    const patched = await call("PATCH", `/${created.id}`, { password: "ghp_new456" });
    expect(patched.status).toBe(200);
    const row = db
      .query<{ password_ciphertext: Uint8Array }, [string]>(
        "SELECT password_ciphertext FROM registry_credentials WHERE id = ?",
      )
      .get(created.id);
    if (!row || !masterKeys) throw new Error("ไม่มีแถวหรือ key");
    expect(
      await decryptEnvelope(
        masterKeys,
        new Uint8Array(row.password_ciphertext),
        `registry:${created.id}`,
      ),
    ).toBe("ghp_new456");

    expect((await call("DELETE", `/${created.id}`)).status).toBe(200);
    expect((await json(await call("GET", "/"))).registries).toHaveLength(0);
    expect((await call("DELETE", `/${created.id}`)).status).toBe(404);
  });
});
