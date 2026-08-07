/**
 * DNS check service — docs/phase-05-domains.md M3 + M5 (Cloudflare awareness)
 *
 * ใช้ hostname จริงที่ resolve ได้แน่นอนไม่ได้ (เทสต์ต้องไม่พึ่งเน็ต) จึง mock
 * node:dns/promises ทั้ง module แล้วป้อนคำตอบที่ต้องการ
 *
 * จุดที่สำคัญที่สุด: Cloudflare IP ต้องได้ "proxied" ไม่ใช่ "mismatch" — ก่อน M5
 * ผู้ใช้ที่เปิด Cloudflare proxy เห็น "ยังไม่ชี้มาที่ server" ทั้งที่ตั้ง DNS ถูกแล้ว
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

// state ที่ mock อ่าน — ตั้งค่าใหม่ต่อเทสต์ผ่าน setResolve()
let v4Result: string[] | Error = [];
let v6Result: string[] | Error = [];

function setResolve(v4: string[] | Error, v6: string[] | Error = new Error("ENOTFOUND")) {
  v4Result = v4;
  v6Result = v6;
}

mock.module("node:dns/promises", () => ({
  default: {
    resolve4: async () => {
      if (v4Result instanceof Error) throw v4Result;
      return v4Result;
    },
    resolve6: async () => {
      if (v6Result instanceof Error) throw v6Result;
      return v6Result;
    },
  },
}));

const { checkDns, loadConfiguredIps } = await import("../src/domains/dns-check");

const SERVER_IP = "103.114.203.205";

afterEach(() => {
  setResolve([], new Error("ENOTFOUND"));
});

describe("checkDns — valid", () => {
  test("A record ตรงกับ configured IP → valid", async () => {
    setResolve([SERVER_IP]);
    const result = await checkDns("example.com", [SERVER_IP]);
    expect(result.status).toBe("valid");
    expect(result.resolvedAddresses).toEqual([SERVER_IP]);
  });

  test("มีหลาย A record และหนึ่งในนั้นตรง → valid", async () => {
    setResolve(["1.2.3.4", SERVER_IP]);
    expect((await checkDns("example.com", [SERVER_IP])).status).toBe("valid");
  });

  test("AAAA ตรงแม้ A ไม่ตรง → valid", async () => {
    setResolve(["1.2.3.4"], ["2001:db8::1"]);
    expect((await checkDns("example.com", ["2001:db8::1"])).status).toBe("valid");
  });
});

describe("checkDns — Cloudflare proxy (M5)", () => {
  test("ทุก A record เป็น Cloudflare → proxied ไม่ใช่ mismatch", async () => {
    setResolve(["104.21.5.10", "172.67.100.1"]);
    const result = await checkDns("example.com", [SERVER_IP]);
    expect(result.status).toBe("proxied");
    expect(result.cloudflareAddresses).toHaveLength(2);
  });

  test("Cloudflare IPv6 อย่างเดียวก็นับเป็น proxied", async () => {
    setResolve(new Error("ENOTFOUND"), ["2606:4700:3033::ac43:a86b"]);
    expect((await checkDns("example.com", [SERVER_IP])).status).toBe("proxied");
  });

  test("Cloudflare v4 + v6 ปนกัน → proxied", async () => {
    setResolve(["104.21.5.10"], ["2606:4700::1"]);
    const result = await checkDns("example.com", [SERVER_IP]);
    expect(result.status).toBe("proxied");
    expect(result.cloudflareAddresses).toHaveLength(2);
  });

  test("Cloudflare ปนกับ IP ที่ไม่รู้จัก → mismatch (ไม่ใช่ทุกตัวเป็น Cloudflare)", async () => {
    // ครึ่ง ๆ แบบนี้มักแปลว่าตั้ง record ค้างไว้ผิด — ต้องเตือน ไม่ใช่บอกว่าปกติ
    setResolve(["104.21.5.10", "8.8.8.8"]);
    const result = await checkDns("example.com", [SERVER_IP]);
    expect(result.status).toBe("mismatch");
    expect(result.cloudflareAddresses).toEqual(["104.21.5.10"]);
  });

  test("Cloudflare ปนกับ origin IP จริง → valid (ชนะทุกกรณี)", async () => {
    setResolve(["104.21.5.10", SERVER_IP]);
    expect((await checkDns("example.com", [SERVER_IP])).status).toBe("valid");
  });
});

describe("checkDns — mismatch / unknown", () => {
  test("ชี้ไป IP อื่นที่ไม่ใช่ Cloudflare → mismatch", async () => {
    setResolve(["8.8.8.8"]);
    const result = await checkDns("example.com", [SERVER_IP]);
    expect(result.status).toBe("mismatch");
    expect(result.cloudflareAddresses).toEqual([]);
  });

  test("resolve ไม่ได้เลย → unknown", async () => {
    setResolve(new Error("ENOTFOUND"), new Error("ENOTFOUND"));
    const result = await checkDns("nonexistent.example.com", [SERVER_IP]);
    expect(result.status).toBe("unknown");
    expect(result.resolvedAddresses).toEqual([]);
  });

  test("configuredIps ว่าง + resolve ได้ IP ธรรมดา → mismatch (fail closed)", async () => {
    // ไม่ตั้ง ZIXPLOY_PUBLIC_IPS ต้องไม่กลายเป็น valid โดยปริยาย
    setResolve(["8.8.8.8"]);
    expect((await checkDns("example.com", [])).status).toBe("mismatch");
  });

  test("configuredIps ว่าง + resolve ได้ Cloudflare → proxied", async () => {
    // Cloudflare ตรวจได้จาก IP range โดยตรง ไม่ต้องรู้ origin IP ของเรา
    setResolve(["104.21.5.10"]);
    expect((await checkDns("example.com", [])).status).toBe("proxied");
  });

  test("เทียบ IP แบบ case-insensitive (IPv6 hex)", async () => {
    setResolve(new Error("ENOTFOUND"), ["2001:DB8::1"]);
    expect((await checkDns("example.com", ["2001:db8::1"])).status).toBe("valid");
  });
});

describe("loadConfiguredIps", () => {
  test("parse comma-separated และตัดช่องว่าง", () => {
    process.env.ZIXPLOY_PUBLIC_IPS = " 1.2.3.4 , 5.6.7.8 ";
    expect(loadConfiguredIps()).toEqual(["1.2.3.4", "5.6.7.8"]);
  });

  test("ไม่ตั้งค่า → [] (ไม่ throw)", () => {
    delete process.env.ZIXPLOY_PUBLIC_IPS;
    expect(loadConfiguredIps()).toEqual([]);
  });

  test("ค่าว่างและ comma เกินถูกกรองทิ้ง", () => {
    process.env.ZIXPLOY_PUBLIC_IPS = "1.2.3.4,,";
    expect(loadConfiguredIps()).toEqual(["1.2.3.4"]);
  });
});
