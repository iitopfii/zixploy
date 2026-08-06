/**
 * rotateEnvVarKeys tests — docs/phase-04-environment.md M5
 *
 * ครอบคลุม:
 * - ไม่มีแถว → ผลลัพธ์ว่าง
 * - แถวที่ใช้ active key อยู่แล้ว → skip
 * - แถวที่ใช้ old key → rotate: decrypt+re-encrypt+UPDATE
 * - idempotent: rotate ซ้ำ → skip ทั้งหมด (ใช้ active key อยู่แล้ว)
 * - version bump: version ที่ rotate แล้วเพิ่มขึ้น 1
 * - decryptAfterRotation ด้วย new active key ได้ค่าเดิม (round-trip)
 * - แถวที่ decrypt ไม่ได้ → failed + skip โดย row อื่นยังทำงานต่อ
 * - batch size < total rows → ยัง rotate ครบทุกแถว
 * - ผสม: บางแถว active, บางแถว old → rotate เฉพาะ old
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import { decryptEnvelope, encryptEnvelope } from "../src/crypto/envelope";
import { createMasterKeys } from "../src/crypto/master-key";
import { rotateEnvVarKeys } from "../src/env/rotation";

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

async function makeKeys(active: number, rawKeys: Record<number, number>) {
  const resolved: Record<number, Uint8Array> = {};
  for (const [id, fill] of Object.entries(rawKeys)) {
    resolved[Number(id)] = new Uint8Array(32).fill(fill);
  }
  return createMasterKeys(active, resolved);
}

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

async function insertEnvVar(
  db: ReturnType<typeof makeDb>,
  masterKeys: Awaited<ReturnType<typeof makeKeys>>,
  projectId: string,
  key: string,
  value: string,
) {
  const aad = `env:${projectId}:${key}`;
  const ciphertext = await encryptEnvelope(masterKeys, value, aad);
  const now = Date.now();
  db.query(
    `INSERT INTO environment_variables
      (id, project_id, key, value_ciphertext, is_secret, scope, enabled, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 'runtime', 1, 1, ?, ?)`,
  ).run(ulid(), projectId, key, ciphertext, now, now);
}

function getRow(db: ReturnType<typeof makeDb>, key: string) {
  return db
    .query<{ value_ciphertext: Buffer; version: number }, [string]>(
      "SELECT value_ciphertext, version FROM environment_variables WHERE key = ?",
    )
    .get(key);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rotateEnvVarKeys — ไม่มีแถว", () => {
  test("คืน total=0, rotated=0, skipped=0", async () => {
    const db = makeDb();
    const keys = await makeKeys(1, { 1: 0x42 });
    const result = await rotateEnvVarKeys(db, keys);
    expect(result).toEqual({ total: 0, rotated: 0, skipped: 0, failed: 0 });
  });
});

describe("rotateEnvVarKeys — already on active key", () => {
  test("แถวที่เข้ารหัสด้วย active key → skip, ไม่เปลี่ยน version", async () => {
    const db = makeDb();
    const keys = await makeKeys(1, { 1: 0x42 });
    const projectId = insertProject(db);
    await insertEnvVar(db, keys, projectId, "MY_VAR", "hello");

    const before = getRow(db, "MY_VAR");
    const result = await rotateEnvVarKeys(db, keys);

    expect(result.skipped).toBe(1);
    expect(result.rotated).toBe(0);
    expect(result.total).toBe(1);

    const after = getRow(db, "MY_VAR");
    // version ต้องไม่เปลี่ยน
    expect(after?.version).toBe(before?.version);
  });
});

describe("rotateEnvVarKeys — rotate old key to new active", () => {
  test("แถวที่เข้ารหัสด้วย old key → rotate: version เพิ่ม 1", async () => {
    const db = makeDb();
    // สร้าง key ด้วย old key id=1
    const oldKeys = await makeKeys(1, { 1: 0x11 });
    const projectId = insertProject(db);
    await insertEnvVar(db, oldKeys, projectId, "SECRET", "my-value");

    // สร้าง masterKeys ที่มีทั้ง old (id=1) และ new active (id=2)
    const newKeys = await makeKeys(2, { 1: 0x11, 2: 0x22 });

    const before = getRow(db, "SECRET");
    const result = await rotateEnvVarKeys(db, newKeys);

    expect(result.rotated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(1);

    const after = getRow(db, "SECRET");
    expect(after?.version).toBe((before?.version ?? 0) + 1);

    // ciphertext ต้องเปลี่ยน (re-encrypted)
    expect(after?.value_ciphertext.toString("hex")).not.toBe(
      before?.value_ciphertext.toString("hex"),
    );
  });

  test("decrypt ด้วย new key หลัง rotate → ได้ค่าเดิม (round-trip)", async () => {
    const db = makeDb();
    const oldKeys = await makeKeys(1, { 1: 0x11 });
    const projectId = insertProject(db);
    await insertEnvVar(db, oldKeys, projectId, "TOKEN", "tok-abc-def");

    const newKeys = await makeKeys(2, { 1: 0x11, 2: 0x22 });
    await rotateEnvVarKeys(db, newKeys);

    const row = getRow(db, "TOKEN");
    const decrypted = await decryptEnvelope(
      newKeys,
      new Uint8Array(row!.value_ciphertext),
      `env:${projectId}:TOKEN`,
    );
    expect(decrypted).toBe("tok-abc-def");
  });
});

describe("rotateEnvVarKeys — idempotent", () => {
  test("rotate ซ้ำ → skip ทั้งหมด (ไม่เพิ่ม version ซ้ำ)", async () => {
    const db = makeDb();
    const oldKeys = await makeKeys(1, { 1: 0x11 });
    const projectId = insertProject(db);
    await insertEnvVar(db, oldKeys, projectId, "VAR1", "v1");

    const newKeys = await makeKeys(2, { 1: 0x11, 2: 0x22 });

    // รอบแรก — rotate
    const r1 = await rotateEnvVarKeys(db, newKeys);
    expect(r1.rotated).toBe(1);

    const after1 = getRow(db, "VAR1");

    // รอบสอง — ต้อง skip เพราะ active key อยู่แล้ว
    const r2 = await rotateEnvVarKeys(db, newKeys);
    expect(r2.skipped).toBe(1);
    expect(r2.rotated).toBe(0);

    const after2 = getRow(db, "VAR1");
    // version ต้องไม่เพิ่มในรอบสอง
    expect(after2?.version).toBe(after1?.version);
  });
});

describe("rotateEnvVarKeys — mixed old/new keys", () => {
  test("บางแถว active, บางแถว old → rotate เฉพาะ old", async () => {
    const db = makeDb();
    const oldKeys = await makeKeys(1, { 1: 0x11 });
    const newKeys = await makeKeys(2, { 1: 0x11, 2: 0x22 });
    const projectId = insertProject(db);

    // old key (id=1)
    await insertEnvVar(db, oldKeys, projectId, "OLD_VAR", "old-val");
    // already new active key (id=2)
    await insertEnvVar(db, newKeys, projectId, "NEW_VAR", "new-val");

    const result = await rotateEnvVarKeys(db, newKeys);
    expect(result.total).toBe(2);
    expect(result.rotated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
  });
});

describe("rotateEnvVarKeys — decrypt failure", () => {
  test("ciphertext เสียหาย → failed++ แต่ row อื่นยัง rotate ต่อ", async () => {
    const db = makeDb();
    const oldKeys = await makeKeys(1, { 1: 0x11 });
    const newKeys = await makeKeys(2, { 1: 0x11, 2: 0x22 });
    const projectId = insertProject(db);

    // Insert junk ciphertext โดยตรง (version=1, key_id=1 แต่ content ผิด)
    const junk = new Uint8Array(30).fill(0xde);
    junk[0] = 0x01; // version
    junk[1] = 0x01; // key_id = 1 (old key) → จะพยายาม rotate แต่ decrypt ไม่ได้
    const now = Date.now();
    db.query(
      `INSERT INTO environment_variables
        (id, project_id, key, value_ciphertext, is_secret, scope, enabled, version, created_at, updated_at)
       VALUES (?, ?, 'BAD_VAR', ?, 0, 'runtime', 1, 1, ?, ?)`,
    ).run(ulid(), projectId, junk, now, now);

    // Insert good var ด้วย old key
    await insertEnvVar(db, oldKeys, projectId, "GOOD_VAR", "good-value");

    const logs: string[] = [];
    const result = await rotateEnvVarKeys(db, newKeys, {
      onProgress: (msg) => logs.push(msg),
    });

    expect(result.failed).toBe(1);
    expect(result.rotated).toBe(1); // GOOD_VAR ยัง rotate สำเร็จ
    expect(result.total).toBe(2);

    // มีการ log warning สำหรับ BAD_VAR
    expect(logs.some((l) => l.includes("BAD_VAR") && l.includes("ข้าม"))).toBe(true);

    // GOOD_VAR ยัง decrypt ได้หลัง rotate
    const row = getRow(db, "GOOD_VAR");
    const decrypted = await decryptEnvelope(
      newKeys,
      new Uint8Array(row!.value_ciphertext),
      `env:${projectId}:GOOD_VAR`,
    );
    expect(decrypted).toBe("good-value");
  });
});

describe("rotateEnvVarKeys — batch size", () => {
  test("batch size < total → ยัง rotate ครบทุกแถว", async () => {
    const db = makeDb();
    const oldKeys = await makeKeys(1, { 1: 0x11 });
    const newKeys = await makeKeys(2, { 1: 0x11, 2: 0x22 });
    const projectId = insertProject(db);

    // สร้าง 7 แถว
    for (let i = 0; i < 7; i++) {
      await insertEnvVar(db, oldKeys, projectId, `VAR_${i}`, `val_${i}`);
    }

    const result = await rotateEnvVarKeys(db, newKeys, { batchSize: 3 });
    expect(result.total).toBe(7);
    expect(result.rotated).toBe(7);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    // verify ทุกแถว decrypt ด้วย new key ได้
    for (let i = 0; i < 7; i++) {
      const row = getRow(db, `VAR_${i}`);
      const decrypted = await decryptEnvelope(
        newKeys,
        new Uint8Array(row!.value_ciphertext),
        `env:${projectId}:VAR_${i}`,
      );
      expect(decrypted).toBe(`val_${i}`);
    }
  });
});
