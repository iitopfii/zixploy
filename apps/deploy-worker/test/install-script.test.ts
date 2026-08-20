/**
 * install.sh — ตรวจ "รูปร่างของสคริปต์" ส่วนที่เกี่ยวกับความปลอดภัยของ control plane
 *
 * รันจริงในเทสต์ไม่ได้ (ต้องมี Docker + เครื่องเปล่า) แต่จุดที่พังแล้วเสียหายหนักคือ:
 *   1. dashboard/API ต้องได้ HTTPS เมื่อมี domain — ไม่งั้นรหัสผ่าน admin เดินทาง plaintext
 *   2. ค่า domain ถูกใส่ลง Traefik rule ตรง ๆ — ต้อง validate ก่อน ไม่งั้นแหก rule ได้
 *
 * ที่มา: base compose ให้ router เฉพาะ entrypoint web ทุกการติดตั้งจึงเป็น HTTP ล้วน
 * และการตั้ง ZIXPLOY_DOMAIN ทำให้ BASE_URL เป็น https:// (cookie ได้ Secure flag)
 * ทั้งที่ไม่มี HTTPS router ให้เข้า → login ไม่ผ่านเลย
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const INSTALL_SH = await Bun.file(
  join(import.meta.dir, "..", "..", "..", "deploy", "install", "install.sh"),
).text();

const BASE_COMPOSE = await Bun.file(
  join(import.meta.dir, "..", "..", "..", "deploy", "install", "docker-compose.yml"),
).text();

describe("install.sh — HTTPS ของ control plane", () => {
  test("สร้าง override เป็นไฟล์แยก ไม่แก้ base compose (ตัวอัปเดตทับ base ได้ต่อ)", () => {
    expect(INSTALL_SH).toContain('OVERRIDE_FILE="$INSTALL_DIR/docker-compose.override.yml"');
    // base compose ต้องไม่มี HTTPS router ฝังอยู่ — เครื่องที่ติดตั้งด้วย IP ขอ ACME cert ไม่ได้
    expect(BASE_COMPOSE).not.toContain("api-secure");
    expect(BASE_COMPOSE).not.toContain("dashboard-secure");
  });

  test("มี domain → router websecure + certresolver ทั้ง dashboard และ API", () => {
    expect(INSTALL_SH).toContain("traefik.http.routers.api-secure.entrypoints");
    expect(INSTALL_SH).toContain("traefik.http.routers.api-secure.tls.certresolver");
    expect(INSTALL_SH).toContain("traefik.http.routers.dashboard-secure.entrypoints");
    expect(INSTALL_SH).toContain("traefik.http.routers.dashboard-secure.tls.certresolver");
  });

  test("บังคับ redirect http→https เมื่อมี domain", () => {
    expect(INSTALL_SH).toContain("redirectscheme.scheme");
    expect(INSTALL_SH).toContain('traefik.http.routers.api.middlewares: "zx-https@docker"');
    expect(INSTALL_SH).toContain('traefik.http.routers.dashboard.middlewares: "zx-https@docker"');
  });

  test("router ของ API ต้องชนะ dashboard บน HTTPS เหมือนฝั่ง HTTP (/api/ ห้ามตกไป dashboard)", () => {
    expect(INSTALL_SH).toContain('traefik.http.routers.dashboard-secure.priority: "1"');
  });

  test("ไม่มี domain → ลบ override เก่าทิ้ง (กันขอ cert ให้ domain ที่เลิกใช้จนติด rate limit)", () => {
    expect(INSTALL_SH).toContain('rm -f "$OVERRIDE_FILE"');
  });

  test("ติดตั้งซ้ำโดยไม่ส่ง ZIXPLOY_DOMAIN → อ่าน domain เดิมคืนจาก .env (HTTPS ไม่หลุด)", () => {
    expect(INSTALL_SH).toContain("^ZIXPLOY_BASE_URL=https://");
  });

  test("เตือนผู้ใช้เมื่อยังเป็น HTTP ว่ารหัสผ่านไม่ถูกเข้ารหัส", () => {
    expect(INSTALL_SH).toContain("ไม่ถูกเข้ารหัสระหว่างทาง");
  });
});

describe("install.sh — validate domain ก่อนใส่ลง Traefik rule", () => {
  /** จำลอง case-pattern เดียวกับในสคริปต์ (POSIX sh glob) */
  function accepts(domain: string): boolean {
    if (domain === "") return false;
    if (domain.startsWith("-") || domain.startsWith(".")) return false;
    return /^[a-zA-Z0-9.-]+$/.test(domain);
  }

  test("สคริปต์มีด่าน validate จริง", () => {
    expect(INSTALL_SH).toContain('*[!a-zA-Z0-9.-]*|-*|.*|"")');
  });

  test("hostname ปกติผ่าน", () => {
    expect(accepts("panel.example.com")).toBe(true);
    expect(accepts("zx-1.sub.example.co.th")).toBe(true);
  });

  test("ค่าที่แหก Traefik rule ได้ต้องถูกปฏิเสธ", () => {
    expect(accepts("a`whoami`.com")).toBe(false); // command substitution ใน heredoc
    expect(accepts("evil.com`) || Host(`x")).toBe(false); // แหกออกไปเขียน rule เอง
    expect(accepts('evil"com')).toBe(false);
    expect(accepts("has space.com")).toBe(false);
    expect(accepts("-lead.com")).toBe(false);
    expect(accepts("")).toBe(false);
  });
});
