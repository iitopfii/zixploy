/**
 * waitForSchema — worker รอ control-api migrate ให้ครบแทนที่จะ exit ทันที
 *
 * ครอบคลุม: schema ครบอยู่แล้ว → ผ่านเงียบ ๆ ไม่มี log, ครบระหว่างรอ → เดินต่อได้,
 * หมดเวลา → คืนสาเหตุ (ผู้เรียก exit ตามเดิม), onWait ถูกเรียกครั้งเดียวไม่ spam,
 * ระหว่างรอไม่แตะ DB (fail closed คงเดิม)
 *
 * ใช้ migration จริงจากดิสก์ + DB จริงใน memory แต่ฉีด sleep/now ปลอมเพื่อไม่ต้องรอเวลาจริง
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { waitForSchema } from "../src/db/wait-schema";

const ALL = loadMigrations(migrationsDir());

function emptyDb() {
  return openDatabase({ path: ":memory:" });
}

/** นาฬิกาปลอมที่เดินหน้าเองทุกครั้งที่ sleep — ทำให้ deadline ถึงได้โดยไม่ต้องรอจริง */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("waitForSchema", () => {
  test("schema ครบอยู่แล้ว → คืน null ทันที ไม่มี log รอ (deploy ปกติเงียบสนิท)", async () => {
    const db = emptyDb();
    migrateUp(db, ALL);
    const clock = fakeClock();
    let waitCalls = 0;
    let readyCalls = 0;

    const result = await waitForSchema(db, ALL, {
      now: clock.now,
      sleep: clock.sleep,
      onWait: () => waitCalls++,
      onReady: () => readyCalls++,
    });

    expect(result).toBeNull();
    expect(waitCalls).toBe(0);
    expect(readyCalls).toBe(0);
  });

  test("schema ครบระหว่างรอ → เดินต่อได้ + แจ้ง onReady (ไม่ exit)", async () => {
    const db = emptyDb();
    // เริ่มด้วย migration ไม่ครบ (จำลอง control-api ยัง migrate ไม่เสร็จ)
    migrateUp(db, ALL.slice(0, ALL.length - 1));

    const clock = fakeClock();
    const waitReasons: string[] = [];
    let readyMs = -1;
    let polls = 0;

    const result = await waitForSchema(db, ALL, {
      now: clock.now,
      sleep: async (ms) => {
        await clock.sleep(ms);
        polls++;
        // รอบที่สาม control-api migrate เสร็จพอดี
        if (polls === 3) migrateUp(db, ALL);
      },
      onWait: (reason) => {
        waitReasons.push(reason);
      },
      onReady: (ms) => {
        readyMs = ms;
      },
    });

    expect(result).toBeNull();
    expect(waitReasons[0]).toContain("missing");
    expect(polls).toBe(3);
    expect(readyMs).toBeGreaterThan(0);
  });

  test("onWait เรียกครั้งเดียวแม้ poll หลายรอบ — ไม่ spam log", async () => {
    const db = emptyDb();
    migrateUp(db, ALL.slice(0, 1));
    const clock = fakeClock();
    let waitCalls = 0;

    await waitForSchema(db, ALL, {
      timeoutMs: 5_000,
      pollMs: 500,
      now: clock.now,
      sleep: clock.sleep,
      onWait: () => waitCalls++,
    });

    expect(waitCalls).toBe(1);
  });

  test("หมดเวลาแล้วยังไม่ครบ → คืนสาเหตุให้ผู้เรียก exit (fail closed คงเดิม)", async () => {
    const db = emptyDb();
    migrateUp(db, ALL.slice(0, 1));
    const clock = fakeClock();

    const result = await waitForSchema(db, ALL, {
      timeoutMs: 2_000,
      pollMs: 500,
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).not.toBeNull();
    expect(result).toContain("missing");
    expect(result).toContain("run migrations before starting");
  });

  test("timeoutMs=0 → คืนทันทีโดยไม่รอเลย (fail-fast แบบเดิม)", async () => {
    const db = emptyDb();
    const clock = fakeClock();
    let slept = 0;

    const result = await waitForSchema(db, ALL, {
      timeoutMs: 0,
      now: clock.now,
      sleep: async (ms) => {
        slept++;
        await clock.sleep(ms);
      },
    });

    expect(result).not.toBeNull();
    expect(slept).toBe(0);
  });

  test("ระหว่างรอไม่เขียน DB เลย — worker ไม่แตะ schema ที่ยังไม่ครบ", async () => {
    const db = emptyDb();
    migrateUp(db, ALL.slice(0, 2));
    const before = db.query<{ c: number }, []>("SELECT count(*) c FROM schema_migrations").get()?.c;
    const clock = fakeClock();

    await waitForSchema(db, ALL, {
      timeoutMs: 2_000,
      pollMs: 500,
      now: clock.now,
      sleep: clock.sleep,
    });

    const after = db.query<{ c: number }, []>("SELECT count(*) c FROM schema_migrations").get()?.c;
    expect(after).toBe(before);
  });
});
