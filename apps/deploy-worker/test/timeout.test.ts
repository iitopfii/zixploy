import { describe, expect, test } from "bun:test";
import { createDeployTimeout } from "../src/pipeline/timeout";

describe("createDeployTimeout", () => {
  test("ไม่มี abort ใด ๆ ก่อนหมดเวลา → signal ยังไม่ aborted, timedOut() เป็น false", () => {
    const parent = new AbortController();
    const dt = createDeployTimeout(parent.signal, 10_000);
    try {
      expect(dt.signal.aborted).toBe(false);
      expect(dt.timedOut()).toBe(false);
    } finally {
      dt.cleanup();
    }
  });

  test("timer หมดเวลา → signal aborted และ timedOut() เป็น true", async () => {
    const parent = new AbortController();
    const dt = createDeployTimeout(parent.signal, 20);
    try {
      await new Promise((r) => setTimeout(r, 60));
      expect(dt.signal.aborted).toBe(true);
      expect(dt.timedOut()).toBe(true);
    } finally {
      dt.cleanup();
    }
  });

  test("parent signal ถูก abort ก่อน timeout → signal aborted แต่ timedOut() ยังเป็น false (สาเหตุคือ parent ไม่ใช่ timer)", async () => {
    const parent = new AbortController();
    const dt = createDeployTimeout(parent.signal, 10_000);
    try {
      parent.abort();
      // ให้ event loop ประมวลผล abort listener
      await Promise.resolve();
      expect(dt.signal.aborted).toBe(true);
      expect(dt.timedOut()).toBe(false);
    } finally {
      dt.cleanup();
    }
  });

  test("parent signal aborted อยู่แล้วตั้งแต่ก่อนสร้าง → signal aborted ทันที, timedOut() เป็น false", () => {
    const parent = new AbortController();
    parent.abort();
    const dt = createDeployTimeout(parent.signal, 10_000);
    try {
      expect(dt.signal.aborted).toBe(true);
      expect(dt.timedOut()).toBe(false);
    } finally {
      dt.cleanup();
    }
  });

  test("cleanup() แล้ว timer ที่ยังไม่หมดเวลาไม่ยิงอีก (ไม่ leak, ไม่ throw ซ้ำ)", async () => {
    const parent = new AbortController();
    const dt = createDeployTimeout(parent.signal, 20);
    dt.cleanup();
    await new Promise((r) => setTimeout(r, 60));
    // cleanup() แค่ clearTimeout — ไม่ได้ abort ทันที ดังนั้น signal ควรยังไม่ aborted และ timedOut() false
    expect(dt.timedOut()).toBe(false);
  });

  test("cleanup() ลบ listener บน parent — parent abort หลัง cleanup ไม่กระทบ signal ที่คืนไปแล้ว", async () => {
    const parent = new AbortController();
    const dt = createDeployTimeout(parent.signal, 10_000);
    dt.cleanup();
    parent.abort();
    await Promise.resolve();
    expect(dt.signal.aborted).toBe(false);
  });
});
