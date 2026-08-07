/**
 * Custom TLS certificate API — HTTP round-trip tests
 * docs/phase-05-domains.md M5
 *
 * ครอบคลุม:
 * - PUT    /projects/:id/domains/:domainId/certificate → validate + encrypt + persist
 * - GET    /projects/:id/domains/:domainId/certificate → metadata เท่านั้น (ไม่มี PEM)
 * - DELETE /projects/:id/domains/:domainId/certificate → กลับไปใช้ Let's Encrypt
 * - cert/key ที่ไม่คู่กัน, cert ที่ไม่ครอบ hostname, key ที่มี passphrase → 422 พร้อม code ที่แยกได้
 * - ไม่มี master key → 503 (ไม่เก็บ cert แบบไม่เข้ารหัส)
 * - **plaintext PEM ต้องไม่โผล่ใน response ใด ๆ และต้องไม่ถูกเก็บแบบ plaintext ใน DB**
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import { ulid } from "@zixploy/shared";
import {
  ENCRYPTED_KEY,
  UNRELATED_KEY,
  VALID_CERT,
  VALID_KEY,
  WILDCARD_CERT,
  WILDCARD_KEY,
} from "../../../internal/shared/test/fixtures/certificates";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { createMasterKeys } from "../src/crypto/master-key";
import { json } from "./helpers";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function makeKeys() {
  return createMasterKeys(1, { 1: new Uint8Array(32).fill(0x42) });
}

/**
 * แต่ละเทสต์ได้ TLS dir ของตัวเอง — materializeCertificates() เขียนไฟล์จริง
 * ถ้าใช้ dir ร่วมกันเทสต์จะเห็น cert ของกันและกัน (full sync ลบไฟล์ที่ไม่รู้จักทิ้ง)
 */
function makeTlsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zx-tls-"));
  process.env.ZIXPLOY_TLS_DIR = dir;
  return dir;
}

async function setup(withKeys = true) {
  const tlsDir = makeTlsDir();
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));

  const now = Date.now();
  db.query(
    "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)",
  ).run(ulid(), await hashPassword("adminpass123"), now, now);

  const projectId = ulid();
  db.query(
    `INSERT INTO projects (id, name, status, dockerfile_path, build_context, restart_policy, deploy_timeout_sec, created_at, updated_at)
     VALUES (?, 'tls-test', 'new', 'Dockerfile', '.', 'unless-stopped', 900, ?, ?)`,
  ).run(projectId, now, now);

  const masterKeys = withKeys ? await makeKeys() : null;
  const app = buildApp(db, { masterKeys });

  const loginRes = await app.handle(
    new Request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "adminpass123" }),
    }),
  );
  const cookies: Record<string, string> = {};
  for (const raw of loginRes.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair?.indexOf("=") ?? -1;
    if (pair && eq > 0) cookies[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");

  return { db, app, projectId, cookie, csrf: cookies.zx_csrf ?? "", tlsDir };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function addDomain(ctx: Ctx, hostname: string): Promise<string> {
  const res = await ctx.app.handle(
    new Request(`http://localhost/api/v1/projects/${ctx.projectId}/domains`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ctx.cookie, "x-csrf-token": ctx.csrf },
      body: JSON.stringify({ hostname, internalPort: 3000 }),
    }),
  );
  return (await json(res)).id as string;
}

function certUrl(ctx: Ctx, domainId: string): string {
  return `http://localhost/api/v1/projects/${ctx.projectId}/domains/${domainId}/certificate`;
}

async function putCert(ctx: Ctx, domainId: string, certificate: string, privateKey: string) {
  return ctx.app.handle(
    new Request(certUrl(ctx, domainId), {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: ctx.cookie, "x-csrf-token": ctx.csrf },
      body: JSON.stringify({ certificate, privateKey }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("PUT certificate — อัปโหลดสำเร็จ", () => {
  test("cert ที่ถูกต้อง → 200, tls_mode เป็น custom, คืน metadata", async () => {
    const ctx = await setup();
    try {
      const domainId = await addDomain(ctx, "example.com");
      const res = await putCert(ctx, domainId, VALID_CERT, VALID_KEY);

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.domain.tlsMode).toBe("custom");
      expect(body.certificate.hostnames).toContain("example.com");
      expect(body.certificate.fingerprint).toMatch(/^[0-9A-F:]+$/);
      expect(body.certificate.notAfter).toBeGreaterThan(Date.now());
    } finally {
      rmSync(ctx.tlsDir, { recursive: true, force: true });
    }
  });

  test("wildcard cert อัปโหลดกับ subdomain ได้", async () => {
    const ctx = await setup();
    try {
      const domainId = await addDomain(ctx, "app.example.com");
      const res = await putCert(ctx, domainId, WILDCARD_CERT, WILDCARD_KEY);
      expect(res.status).toBe(200);
    } finally {
      rmSync(ctx.tlsDir, { recursive: true, force: true });
    }
  });

  test("อัปโหลดทับใบเดิมได้ — fingerprint เปลี่ยนตามใบใหม่", async () => {
    const ctx = await setup();
    try {
      const domainId = await addDomain(ctx, "www.example.com");
      const first = await json(await putCert(ctx, domainId, VALID_CERT, VALID_KEY));
      const second = await json(await putCert(ctx, domainId, WILDCARD_CERT, WILDCARD_KEY));
      expect(second.certificate.fingerprint).not.toBe(first.certificate.fingerprint);
    } finally {
      rmSync(ctx.tlsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Materialization — ไฟล์ที่ Traefik ต้องอ่าน
// ---------------------------------------------------------------------------

describe("PUT certificate — เขียนไฟล์ให้ Traefik", () => {
  test("สร้าง .crt/.key และ dynamic config ที่อ้างถึงไฟล์ทั้งคู่", async () => {
    const ctx = await setup();
    try {
      const domainId = await addDomain(ctx, "example.com");
      await putCert(ctx, domainId, VALID_CERT, VALID_KEY);

      expect(readFileSync(join(ctx.tlsDir, "certs", `${domainId}.crt`), "utf8")).toContain(
        "BEGIN CERTIFICATE",
      );
      expect(readFileSync(join(ctx.tlsDir, "certs", `${domainId}.key`), "utf8")).toContain(
        "BEGIN PRIVATE KEY",
      );

      const config = JSON.parse(
        readFileSync(join(ctx.tlsDir, "dynamic", "certificates.json"), "utf8"),
      );
      expect(config.tls.certificates).toHaveLength(1);
      expect(config.tls.certificates[0].certFile).toContain(`${domainId}.crt`);
      expect(config.tls.certificates[0].keyFile).toContain(`${domainId}.key`);
    } finally {
      rmSync(ctx.tlsDir, { recursive: true, force: true });
    }
  });

  test("ลบ certificate แล้วไฟล์หายจาก disk และ config ว่าง", async () => {
    const ctx = await setup();
    try {
      const domainId = await addDomain(ctx, "example.com");
      await putCert(ctx, domainId, VALID_CERT, VALID_KEY);

      await ctx.app.handle(
        new Request(certUrl(ctx, domainId), {
          method: "DELETE",
          headers: { cookie: ctx.cookie, "x-csrf-token": ctx.csrf },
        }),
      );

      expect(() => readFileSync(join(ctx.tlsDir, "certs", `${domainId}.key`))).toThrow();
      const config = JSON.parse(
        readFileSync(join(ctx.tlsDir, "dynamic", "certificates.json"), "utf8"),
      );
      expect(config.tls.certificates).toEqual([]);
    } finally {
      rmSync(ctx.tlsDir, { recursive: true, force: true });
    }
  });

  test("ปิด domain (enabled=false) → cert ถูกถอดออกจาก disk", async () => {
    // disabled domain ที่ยังมี cert ค้างจะทำให้ Traefik ตอบ SNI นั้นได้ทั้งที่ไม่มี router
    const ctx = await setup();
    try {
      const domainId = await addDomain(ctx, "example.com");
      await putCert(ctx, domainId, VALID_CERT, VALID_KEY);

      await ctx.app.handle(
        new Request(`http://localhost/api/v1/projects/${ctx.projectId}/domains/${domainId}`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            cookie: ctx.cookie,
            "x-csrf-token": ctx.csrf,
          },
          body: JSON.stringify({ enabled: false }),
        }),
      );

      expect(() => readFileSync(join(ctx.tlsDir, "certs", `${domainId}.key`))).toThrow();
    } finally {
      rmSync(ctx.tlsDir, { recursive: true, force: true });
    }
  });

  test("ลบ domain ทั้งอัน → cert ไม่เหลือค้างบน disk", async () => {
    const ctx = await setup();
    try {
      const domainId = await addDomain(ctx, "example.com");
      await putCert(ctx, domainId, VALID_CERT, VALID_KEY);

      await ctx.app.handle(
        new Request(`http://localhost/api/v1/projects/${ctx.projectId}/domains/${domainId}`, {
          method: "DELETE",
          headers: { cookie: ctx.cookie, "x-csrf-token": ctx.csrf },
        }),
      );

      expect(() => readFileSync(join(ctx.tlsDir, "certs", `${domainId}.crt`))).toThrow();
    } finally {
      rmSync(ctx.tlsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Validation failures
// ---------------------------------------------------------------------------

describe("PUT certificate — ปฏิเสธ input ที่ผิด", () => {
  async function expectRejected(cert: string, key: string, hostname: string, expectedCode: string) {
    const ctx = await setup();
    try {
      const domainId = await addDomain(ctx, hostname);
      const res = await putCert(ctx, domainId, cert, key);
      expect(res.status).toBe(422);
      expect((await json(res)).error.code).toBe(expectedCode);

      // ต้องไม่เปลี่ยน tls_mode เมื่อ validation ไม่ผ่าน
      const row = ctx.db
        .query<{ tls_mode: string }, [string]>("SELECT tls_mode FROM project_domains WHERE id = ?")
        .get(domainId);
      expect(row?.tls_mode).toBe("letsencrypt");
    } finally {
      rmSync(ctx.tlsDir, { recursive: true, force: true });
    }
  }

  test("key ไม่ตรงกับ cert → TLS_CERT_KEY_MISMATCH", async () => {
    await expectRejected(VALID_CERT, UNRELATED_KEY, "example.com", "TLS_CERT_KEY_MISMATCH");
  });

  test("cert ไม่ครอบ hostname → TLS_CERT_HOSTNAME_MISMATCH", async () => {
    await expectRejected(VALID_CERT, VALID_KEY, "other-domain.com", "TLS_CERT_HOSTNAME_MISMATCH");
  });

  test("key มี passphrase → TLS_KEY_INVALID", async () => {
    await expectRejected(VALID_CERT, ENCRYPTED_KEY, "example.com", "TLS_KEY_INVALID");
  });

  test("cert ไม่ใช่ PEM → TLS_CERT_INVALID", async () => {
    await expectRejected("ไม่ใช่ certificate", VALID_KEY, "example.com", "TLS_CERT_INVALID");
  });

  test("ไม่มี master key → 503 (ไม่เก็บ cert แบบไม่เข้ารหัส)", async () => {
    const ctx = await setup(false);
    try {
      const domainId = await addDomain(ctx, "example.com");
      const res = await putCert(ctx, domainId, VALID_CERT, VALID_KEY);
      expect(res.status).toBe(503);
      expect((await json(res)).error.code).toBe("TLS_ENCRYPTION_NOT_CONFIGURED");
    } finally {
      rmSync(ctx.tlsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Secret hygiene — สำคัญที่สุดของ milestone นี้
// ---------------------------------------------------------------------------

describe("private key ต้องไม่รั่ว", () => {
  /** ส่วนกลางของ base64 ใน key — ยาวพอที่จะไม่ match อะไรโดยบังเอิญ */
  const KEY_MATERIAL = (VALID_KEY.split("\n")[2] as string).slice(0, 40);

  test("response ของ PUT ไม่มีเนื้อ PEM ของ cert หรือ key", async () => {
    const ctx = await setup();
    try {
      const domainId = await addDomain(ctx, "example.com");
      const raw = await (await putCert(ctx, domainId, VALID_CERT, VALID_KEY)).text();
      expect(raw).not.toContain(KEY_MATERIAL);
      expect(raw).not.toContain("BEGIN PRIVATE KEY");
      expect(raw).not.toContain("BEGIN CERTIFICATE");
    } finally {
      rmSync(ctx.tlsDir, { recursive: true, force: true });
    }
  });

  test("GET certificate คืนแค่ metadata — ไม่มี PEM", async () => {
    const ctx = await setup();
    try {
      const domainId = await addDomain(ctx, "example.com");
      await putCert(ctx, domainId, VALID_CERT, VALID_KEY);

      const res = await ctx.app.handle(
        new Request(certUrl(ctx, domainId), { headers: { cookie: ctx.cookie } }),
      );
      expect(res.status).toBe(200);
      const raw = await res.text();
      expect(raw).not.toContain(KEY_MATERIAL);
      expect(raw).not.toContain("BEGIN");
      expect(JSON.parse(raw).fingerprint).toBeTruthy();
    } finally {
      rmSync(ctx.tlsDir, { recursive: true, force: true });
    }
  });

  test("GET /domains (list) ไม่มี PEM ใด ๆ", async () => {
    const ctx = await setup();
    try {
      const domainId = await addDomain(ctx, "example.com");
      await putCert(ctx, domainId, VALID_CERT, VALID_KEY);

      const res = await ctx.app.handle(
        new Request(`http://localhost/api/v1/projects/${ctx.projectId}/domains`, {
          headers: { cookie: ctx.cookie },
        }),
      );
      const raw = await res.text();
      expect(raw).not.toContain(KEY_MATERIAL);
      expect(raw).not.toContain("BEGIN");
      // แต่ต้องมี metadata ให้ UI แสดงสถานะได้
      expect(JSON.parse(raw).domains[0].tlsMode).toBe("custom");
      expect(JSON.parse(raw).domains[0].tlsCertFingerprint).toBeTruthy();
    } finally {
      rmSync(ctx.tlsDir, { recursive: true, force: true });
    }
  });

  test("DB เก็บ ciphertext ไม่ใช่ plaintext PEM", async () => {
    const ctx = await setup();
    try {
      const domainId = await addDomain(ctx, "example.com");
      await putCert(ctx, domainId, VALID_CERT, VALID_KEY);

      const row = ctx.db
        .query<{ tls_key_ciphertext: Buffer; tls_cert_ciphertext: Buffer }, [string]>(
          "SELECT tls_key_ciphertext, tls_cert_ciphertext FROM project_domains WHERE id = ?",
        )
        .get(domainId);

      const keyBlob = row?.tls_key_ciphertext.toString("utf8") ?? "";
      const certBlob = row?.tls_cert_ciphertext.toString("utf8") ?? "";
      expect(keyBlob).not.toContain("BEGIN PRIVATE KEY");
      expect(keyBlob).not.toContain(KEY_MATERIAL);
      expect(certBlob).not.toContain("BEGIN CERTIFICATE");
    } finally {
      rmSync(ctx.tlsDir, { recursive: true, force: true });
    }
  });

  test("ciphertext ของ cert กับ key สลับกันไม่ได้ (AAD ผูกกับ field)", async () => {
    const ctx = await setup();
    try {
      const domainId = await addDomain(ctx, "example.com");
      await putCert(ctx, domainId, VALID_CERT, VALID_KEY);

      // สลับสองช่องใน DB แล้ว sync ใหม่ — decrypt ต้องล้มทั้งคู่ ไม่ใช่ได้ PEM ที่สลับตำแหน่ง
      ctx.db
        .query(
          `UPDATE project_domains SET
             tls_cert_ciphertext = (SELECT tls_key_ciphertext FROM project_domains WHERE id = ?),
             tls_key_ciphertext  = (SELECT tls_cert_ciphertext FROM project_domains WHERE id = ?)
           WHERE id = ?`,
        )
        .run(domainId, domainId, domainId);

      const { decryptActiveCertificates } = await import("../src/domains/tls-store");
      const { createMasterKeys: mk } = await import("../src/crypto/master-key");
      const keys = mk(1, { 1: new Uint8Array(32).fill(0x42) });
      const failures: string[] = [];
      const result = await decryptActiveCertificates(ctx.db, await keys, (id) => failures.push(id));

      expect(result).toEqual([]);
      expect(failures).toContain(domainId);
    } finally {
      rmSync(ctx.tlsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// DELETE certificate
// ---------------------------------------------------------------------------

describe("DELETE certificate", () => {
  test("กลับไปใช้ Let's Encrypt และล้าง metadata ทั้งหมด", async () => {
    const ctx = await setup();
    try {
      const domainId = await addDomain(ctx, "example.com");
      await putCert(ctx, domainId, VALID_CERT, VALID_KEY);

      const res = await ctx.app.handle(
        new Request(certUrl(ctx, domainId), {
          method: "DELETE",
          headers: { cookie: ctx.cookie, "x-csrf-token": ctx.csrf },
        }),
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.tlsMode).toBe("letsencrypt");
      expect(body.tlsCertFingerprint).toBeNull();
      expect(body.tlsCertNotAfter).toBeNull();
    } finally {
      rmSync(ctx.tlsDir, { recursive: true, force: true });
    }
  });

  test("domain ที่ไม่มี custom cert → 404 TLS_CERT_NOT_FOUND", async () => {
    const ctx = await setup();
    try {
      const domainId = await addDomain(ctx, "example.com");
      const res = await ctx.app.handle(
        new Request(certUrl(ctx, domainId), {
          method: "DELETE",
          headers: { cookie: ctx.cookie, "x-csrf-token": ctx.csrf },
        }),
      );
      expect(res.status).toBe(404);
      expect((await json(res)).error.code).toBe("TLS_CERT_NOT_FOUND");
    } finally {
      rmSync(ctx.tlsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("authorization", () => {
  test("ไม่ล็อกอิน → 401", async () => {
    const ctx = await setup();
    try {
      const domainId = await addDomain(ctx, "example.com");
      const res = await ctx.app.handle(
        new Request(certUrl(ctx, domainId), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ certificate: VALID_CERT, privateKey: VALID_KEY }),
        }),
      );
      expect(res.status).toBe(401);
    } finally {
      rmSync(ctx.tlsDir, { recursive: true, force: true });
    }
  });

  test("domain ของ project อื่น → 404", async () => {
    const ctx = await setup();
    try {
      const domainId = await addDomain(ctx, "example.com");
      const res = await ctx.app.handle(
        new Request(`http://localhost/api/v1/projects/${ulid()}/domains/${domainId}/certificate`, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: ctx.cookie,
            "x-csrf-token": ctx.csrf,
          },
          body: JSON.stringify({ certificate: VALID_CERT, privateKey: VALID_KEY }),
        }),
      );
      expect(res.status).toBe(404);
    } finally {
      rmSync(ctx.tlsDir, { recursive: true, force: true });
    }
  });
});
