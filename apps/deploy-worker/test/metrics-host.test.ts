/**
 * Host metrics parser tests — Phase 9 M2
 *
 * parser ทุกตัวเป็น pure function จึงเทสต์ได้โดยไม่ต้องมี /proc จริง
 * (สำคัญเพราะ CI/dev รันบน macOS/Windows ที่ไม่มี /proc เลย)
 */

import { describe, expect, test } from "bun:test";
import {
  cpuPercentFromDelta,
  parseDf,
  parseLoadAvg,
  parseMemInfo,
  parseProcStat,
} from "../src/metrics/host";

// ---------------------------------------------------------------------------
// parseProcStat
// ---------------------------------------------------------------------------

const PROC_STAT = `cpu  100 20 50 800 30 0 10 0 0 0
cpu0 50 10 25 400 15 0 5 0 0 0
cpu1 50 10 25 400 15 0 5 0 0 0
intr 12345
ctxt 67890
`;

describe("parseProcStat", () => {
  test("รวม 8 field แรกเป็น total และ idle+iowait เป็น idle", () => {
    const snap = parseProcStat(PROC_STAT);
    expect(snap).not.toBeNull();
    // 100+20+50+800+30+0+10+0 = 1010
    expect(snap?.total).toBe(1010);
    // idle 800 + iowait 30
    expect(snap?.idle).toBe(830);
  });

  test("นับจำนวน core จากบรรทัด cpu0..cpuN", () => {
    expect(parseProcStat(PROC_STAT)?.count).toBe(2);
  });

  test("ไม่มีบรรทัด cpuN แยก → count เป็น 1 (ไม่ใช่ 0 ซึ่ง CHECK ใน DB จะ reject)", () => {
    expect(parseProcStat("cpu  1 2 3 4 5 6 7 8\n")?.count).toBe(1);
  });

  test("ไม่มีบรรทัด 'cpu ' เลย → null", () => {
    expect(parseProcStat("intr 1\nctxt 2\n")).toBeNull();
  });

  test("ค่าไม่ใช่ตัวเลข → null (ไม่คืน NaN ให้หลุดลง DB)", () => {
    expect(parseProcStat("cpu  x y z w\n")).toBeNull();
  });

  test("guest/guest_nice ไม่ถูกนับซ้ำ — field ที่ 9-10 ไม่กระทบ total", () => {
    const withGuest = parseProcStat("cpu  100 20 50 800 30 0 10 0 999 888\n");
    const withoutGuest = parseProcStat("cpu  100 20 50 800 30 0 10 0 0 0\n");
    expect(withGuest?.total).toBe(withoutGuest?.total as number);
  });
});

// ---------------------------------------------------------------------------
// cpuPercentFromDelta
// ---------------------------------------------------------------------------

describe("cpuPercentFromDelta", () => {
  test("busy 50% เมื่อ idle เพิ่มครึ่งหนึ่งของ total", () => {
    const prev = { total: 1000, idle: 800, count: 1 };
    const curr = { total: 2000, idle: 1300, count: 1 };
    // totalDelta 1000, idleDelta 500 → busy 50%
    expect(cpuPercentFromDelta(prev, curr)).toBeCloseTo(50);
  });

  test("idle ไม่ขยับเลย → 100%", () => {
    expect(
      cpuPercentFromDelta({ total: 0, idle: 0, count: 1 }, { total: 100, idle: 0, count: 1 }),
    ).toBe(100);
  });

  test("idle ขยับเท่า total → 0%", () => {
    expect(
      cpuPercentFromDelta({ total: 0, idle: 0, count: 1 }, { total: 100, idle: 100, count: 1 }),
    ).toBe(0);
  });

  test("total ไม่เพิ่ม → null (ข้ามรอบ ไม่รายงาน 0% ที่อ่านเหมือนเครื่องว่าง)", () => {
    const same = { total: 1000, idle: 500, count: 1 };
    expect(cpuPercentFromDelta(same, same)).toBeNull();
  });

  test("counter reset หลัง host reboot (total ลดลง) → null", () => {
    expect(
      cpuPercentFromDelta({ total: 9999, idle: 100, count: 1 }, { total: 10, idle: 5, count: 1 }),
    ).toBeNull();
  });

  test("ผลลัพธ์ถูก clamp อยู่ใน 0-100 เสมอ", () => {
    // idleDelta ติดลบผิดปกติ → busy เกิน 100 ถ้าไม่ clamp
    const value = cpuPercentFromDelta(
      { total: 1000, idle: 900, count: 1 },
      { total: 1100, idle: 800, count: 1 },
    );
    expect(value).toBeLessThanOrEqual(100);
    expect(value).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// parseMemInfo
// ---------------------------------------------------------------------------

describe("parseMemInfo", () => {
  test("used = total - available (ไม่ใช่ total - free)", () => {
    const mem = parseMemInfo(
      "MemTotal:       1000 kB\nMemFree:  100 kB\nMemAvailable:    600 kB\n",
    );
    expect(mem?.totalBytes).toBe(1000 * 1024);
    expect(mem?.usedBytes).toBe(400 * 1024);
  });

  test("ไม่มี MemAvailable → null (ไม่เดาจาก MemFree ซึ่งไม่รวม cache ที่คืนได้)", () => {
    expect(parseMemInfo("MemTotal: 1000 kB\nMemFree: 100 kB\n")).toBeNull();
  });

  test("MemTotal เป็น 0 → null (กันหารศูนย์ตอนคิด %)", () => {
    expect(parseMemInfo("MemTotal: 0 kB\nMemAvailable: 0 kB\n")).toBeNull();
  });

  test("available มากกว่า total (ผิดปกติ) → used ไม่ติดลบ", () => {
    const mem = parseMemInfo("MemTotal: 100 kB\nMemAvailable: 200 kB\n");
    expect(mem?.usedBytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseLoadAvg
// ---------------------------------------------------------------------------

describe("parseLoadAvg", () => {
  test("อ่านสามค่าแรก ข้าม running/pid ที่ตามมา", () => {
    expect(parseLoadAvg("0.15 0.20 0.18 1/234 5678\n")).toEqual([0.15, 0.2, 0.18]);
  });

  test("มีไม่ครบสามค่า → null", () => {
    expect(parseLoadAvg("0.15 0.20\n")).toBeNull();
  });

  test("ค่าไม่ใช่ตัวเลข → null", () => {
    expect(parseLoadAvg("a b c 1/2 3\n")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseDf
// ---------------------------------------------------------------------------

describe("parseDf", () => {
  const DF_OUTPUT = `Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/sda1         51475068  7812500  41049444      17% /workspaces
`;

  test("แปลง 1024-block เป็น bytes", () => {
    const disk = parseDf(DF_OUTPUT);
    expect(disk?.totalBytes).toBe(51475068 * 1024);
    expect(disk?.usedBytes).toBe(7812500 * 1024);
  });

  test("มีแต่ header ไม่มีข้อมูล → null", () => {
    expect(parseDf("Filesystem 1024-blocks Used Available Capacity Mounted on\n")).toBeNull();
  });

  test("total เป็น 0 → null (CHECK ใน DB บังคับ > 0 อยู่แล้ว)", () => {
    expect(
      parseDf("Filesystem 1024-blocks Used Available Capacity Mounted on\ntmpfs 0 0 0 0% /x\n"),
    ).toBeNull();
  });

  test("field ไม่ครบ → null", () => {
    expect(parseDf("Filesystem 1024-blocks\n/dev/sda1 100\n")).toBeNull();
  });

  test("ชื่อ device ยาวแต่ -P บังคับบรรทัดเดียว — parse ได้ปกติ", () => {
    const long = `Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/mapper/very-long-volume-group-name-lv-docker 1000 400 600 40% /workspaces
`;
    const disk = parseDf(long);
    expect(disk?.totalBytes).toBe(1000 * 1024);
    expect(disk?.usedBytes).toBe(400 * 1024);
  });
});
