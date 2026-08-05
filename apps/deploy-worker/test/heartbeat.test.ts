import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { beat, heartbeatLoop } from "../src/heartbeat";

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

describe("worker heartbeat", () => {
  test("beat แรก insert, beat ต่อไป update last_beat_at โดยคง started_at", () => {
    const db = makeDb();
    const startedAt = Date.now() - 60_000;
    beat(db, "w1", startedAt);
    beat(db, "w1", startedAt);

    const rows = db
      .query<{ worker_id: string; started_at: number; last_beat_at: number }, []>(
        "SELECT * FROM worker_heartbeats",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.started_at).toBe(startedAt);
    expect(rows[0]?.last_beat_at).toBeGreaterThan(startedAt);
  });

  test("heartbeatLoop เขียนอย่างน้อยหนึ่งครั้งและหยุดเมื่อ abort", async () => {
    const db = makeDb();
    const controller = new AbortController();
    const loop = heartbeatLoop(db, "w2", controller.signal);

    // ให้เวลาเขียน beat แรกแล้วสั่งหยุด
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await loop; // ต้อง resolve ไม่ค้าง

    const row = db
      .query<{ worker_id: string }, []>(
        "SELECT worker_id FROM worker_heartbeats WHERE worker_id = 'w2'",
      )
      .get();
    expect(row?.worker_id).toBe("w2");
  });
});
