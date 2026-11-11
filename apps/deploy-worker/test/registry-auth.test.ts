/**
 * loadRegistryAuth + writeTempDockerConfig (0.1.24)
 *
 * - เลือกแถวตาม registry host ของ image ref, ไม่มีแถว = null
 * - ถอดรหัสด้วย AAD registry:<id> (ตรงกับ control-api) · ถอดไม่ได้/ไม่มี key = โยน (ไม่ pull เงียบ ๆ)
 * - config ชั่วคราวมีแค่ auth ของ registry นั้น · Docker Hub ใช้ key legacy
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { writeTempDockerConfig } from "../src/docker/cli-client";
import { encryptEnvelope } from "../src/github/envelope";
import { createMasterKeys } from "../src/github/master-key";
import { loadRegistryAuth, markRegistryUsed } from "../src/registries/auth";

const makeKeys = (fill = 0x42) => createMasterKeys(1, { 1: new Uint8Array(32).fill(fill) });

async function setup() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  const masterKeys = await makeKeys();
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO registry_credentials (id, registry, username, password_ciphertext, created_at, updated_at)
     VALUES (?, 'ghcr.io', 'bot', ?, ?, ?)`,
  ).run(id, await encryptEnvelope(masterKeys, "ghp_secret", `registry:${id}`), now, now);
  return { db, masterKeys, id };
}

describe("loadRegistryAuth", () => {
  test("image จาก registry ที่มี credential → ถอดรหัสได้", async () => {
    const { db, masterKeys, id } = await setup();
    const auth = await loadRegistryAuth(db, masterKeys, "ghcr.io/acme/api:1.0.0");
    expect(auth).toEqual({ id, registry: "ghcr.io", username: "bot", password: "ghp_secret" });
  });

  test("registry อื่น (Docker Hub) → null", async () => {
    const { db, masterKeys } = await setup();
    expect(await loadRegistryAuth(db, masterKeys, "nginx:1.27")).toBeNull();
  });

  test("ไม่มี master key แต่มีแถว → โยน", async () => {
    const { db } = await setup();
    await expect(loadRegistryAuth(db, null, "ghcr.io/acme/api:1")).rejects.toThrow("master key");
  });

  test("key ผิด → โยน (ไม่ pull แบบไม่ login เงียบ ๆ)", async () => {
    const { db } = await setup();
    await expect(loadRegistryAuth(db, await makeKeys(0x11), "ghcr.io/acme/api:1")).rejects.toThrow(
      "ถอดรหัส",
    );
  });

  test("markRegistryUsed ตั้ง last_used_at", async () => {
    const { db, id } = await setup();
    markRegistryUsed(db, id);
    const row = db
      .query<{ last_used_at: number | null }, [string]>(
        "SELECT last_used_at FROM registry_credentials WHERE id = ?",
      )
      .get(id);
    expect(row?.last_used_at).toBeGreaterThan(0);
  });
});

describe("writeTempDockerConfig", () => {
  test("มีแค่ auth ของ registry นั้น (base64 user:pass)", () => {
    const dir = writeTempDockerConfig({ registry: "ghcr.io", username: "bot", password: "s3cret" });
    try {
      const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
      expect(Object.keys(config.auths)).toEqual(["ghcr.io"]);
      expect(Buffer.from(config.auths["ghcr.io"].auth, "base64").toString()).toBe("bot:s3cret");
      if (process.platform !== "win32") {
        expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Docker Hub ใช้ key legacy ที่ CLI รู้จัก", () => {
    const dir = writeTempDockerConfig({ registry: "docker.io", username: "u", password: "p" });
    try {
      const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
      expect(Object.keys(config.auths)).toEqual(["https://index.docker.io/v1/"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
