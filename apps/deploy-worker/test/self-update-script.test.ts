/**
 * updateScript / fetchComposeFile — unit tests
 *
 * สคริปต์ที่ updater รันคือจุดที่พังแล้วทั้งเครื่องขึ้นไม่ได้ (compose file คือสิ่งเดียวที่บอกว่า
 * ระบบประกอบด้วยอะไร) จึงตรวจ "รูปร่างของสคริปต์" ไว้ให้ครบ — รันจริงไม่ได้ในเทสต์เพราะต้องมี
 * Docker daemon + ไฟล์ติดตั้งบน host
 *
 * ที่มา: updater เดิมไม่เคยอัปเดต docker-compose.yml เลย (แค่ pull + up -d) การแก้ compose
 * ในรุ่นถัดมาจึงไปไม่ถึงเครื่องที่อัปเดตผ่านปุ่ม — พบตอนเพิ่ม ZIXPLOY_INSTALL_DIR ในรุ่น 0.1.15
 */

import { describe, expect, test } from "bun:test";
import { composeFileUrl } from "@zixploy/shared";
import { fetchComposeFile, updateScript } from "../src/maintenance/self-update";

describe("updateScript — ขั้นตอนที่ต้องมีเสมอ", () => {
  const script = updateScript("0.1.16", true);

  test("เขียนเวอร์ชันลง .env ก่อนแตะ compose (config ต้อง interpolate ตัวแปรได้)", () => {
    const envIdx = script.indexOf("ZIXPLOY_VERSION=0.1.16");
    const composeIdx = script.indexOf("docker compose config");
    expect(envIdx).toBeGreaterThan(-1);
    expect(composeIdx).toBeGreaterThan(envIdx);
  });

  test("สำรอง compose เดิมก่อนทับเสมอ", () => {
    expect(script).toContain("cp docker-compose.yml docker-compose.yml.bak");
  });

  test("ตรวจ compose ใหม่ด้วย config ก่อนใช้ — ไม่ผ่านต้องคืนไฟล์เดิม", () => {
    expect(script).toContain("docker compose config");
    expect(script).toContain("mv docker-compose.yml.bak docker-compose.yml");
  });

  test("pull และ up ล้มเหลว → เรียก restore_compose แล้ว exit ไม่ใช่ปล่อยค้าง", () => {
    expect(script).toContain("docker compose pull || { restore_compose; exit 1; }");
    expect(script).toContain(
      "docker compose up -d --remove-orphans || { restore_compose; exit 1; }",
    );
  });

  test("restore_compose พยายาม start ระบบกลับด้วย compose เดิม", () => {
    expect(script).toContain("restore_compose() {");
    expect(script).toContain("docker compose up -d --remove-orphans || true");
  });

  test("ใช้ printf ไม่ใช่ echo ตอนเขียน YAML (echo ตีความ backslash ในบางเชลล์)", () => {
    expect(script).toContain('printf %s "$ZIXPLOY_NEW_COMPOSE"');
    expect(script).not.toContain('echo "$ZIXPLOY_NEW_COMPOSE"');
  });

  test("ลบไฟล์สำรองทิ้งเมื่อสำเร็จ — ไม่ทิ้งขยะไว้ในโฟลเดอร์ติดตั้ง", () => {
    expect(script).toContain("rm -f docker-compose.yml.bak");
  });
});

describe("updateScript — ไม่มี compose ใหม่ (fail-soft)", () => {
  const script = updateScript("0.1.16", false);

  test("ไม่แตะ compose เลย — ยังคงพฤติกรรมเดิมของ updater", () => {
    expect(script).not.toContain("docker-compose.yml.new");
    expect(script).not.toContain("ZIXPLOY_NEW_COMPOSE");
    expect(script).not.toContain("cp docker-compose.yml docker-compose.yml.bak");
  });

  test("ยังอัปเดตเวอร์ชันและ pull/up ตามปกติ", () => {
    expect(script).toContain("ZIXPLOY_VERSION=0.1.16");
    expect(script).toContain("docker compose pull");
    expect(script).toContain("docker compose up -d --remove-orphans");
  });

  test("restore_compose ไม่ทำอะไรเพราะไม่เคย swap (COMPOSE_SWAPPED=0)", () => {
    expect(script).toContain("COMPOSE_SWAPPED=0");
  });
});

describe("composeFileUrl — ต้องปักหมุดตาม tag ไม่ใช่ main", () => {
  test("ชี้ไปที่ tag ของเวอร์ชันเป้าหมาย", () => {
    expect(composeFileUrl("0.1.16")).toBe(
      "https://raw.githubusercontent.com/iitopfii/zixploy/v0.1.16/deploy/install/docker-compose.yml",
    );
  });

  test("ไม่ดึงจาก main — main อาจล้ำหน้าไปหลายรุ่นแล้ว", () => {
    expect(composeFileUrl("0.1.16")).not.toContain("/main/");
  });
});

describe("fetchComposeFile — fail-soft + ตรวจเนื้อหา", () => {
  const realFetch = globalThis.fetch;

  function mockFetch(impl: () => Promise<Response>) {
    globalThis.fetch = impl as unknown as typeof fetch;
    return () => {
      globalThis.fetch = realFetch;
    };
  }

  test("HTTP ไม่ 2xx → null (ไม่ throw)", async () => {
    const restore = mockFetch(async () => new Response("Not Found", { status: 404 }));
    expect(await fetchComposeFile("0.1.16")).toBeNull();
    restore();
  });

  test("network error → null (ไม่ throw)", async () => {
    const restore = mockFetch(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    expect(await fetchComposeFile("0.1.16")).toBeNull();
    restore();
  });

  test("ตอบ HTML มาด้วย 200 (หน้า error ของ proxy) → null", async () => {
    const restore = mockFetch(async () => new Response("<html><body>404</body></html>"));
    expect(await fetchComposeFile("0.1.16")).toBeNull();
    restore();
  });

  test("YAML ที่ขาด service ที่ระบบต้องใช้ → null", async () => {
    const restore = mockFetch(
      async () => new Response("services:\n  control-api:\n    image: x\n"),
    );
    expect(await fetchComposeFile("0.1.16")).toBeNull();
    restore();
  });

  test("compose ที่ครบทุก service → คืนเนื้อหาดิบตามเดิมทุกตัวอักษร", async () => {
    const yaml = [
      "services:",
      "  control-api:",
      "    image: ghcr.io/iitopfii/zixploy-control-api:${ZIXPLOY_VERSION}",
      "  deploy-worker:",
      "    image: ghcr.io/iitopfii/zixploy-deploy-worker:${ZIXPLOY_VERSION}",
      "  dashboard:",
      "    image: ghcr.io/iitopfii/zixploy-dashboard:${ZIXPLOY_VERSION}",
      "",
    ].join("\n");
    const restore = mockFetch(async () => new Response(yaml));
    expect(await fetchComposeFile("0.1.16")).toBe(yaml);
    restore();
  });
});
