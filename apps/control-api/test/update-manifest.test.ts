/**
 * Parse manifest/config จาก GHCR เพื่อหาวันที่ build ของ image — updates/check.ts
 * ครอบคลุม: index multi-arch (เลือก linux ข้าม attestation), manifest เดี่ยว,
 * config มี/ไม่มี created, JSON เพี้ยนทุกแบบ → null (fail-soft)
 */

import { describe, expect, test } from "bun:test";
import {
  extractConfigDigest,
  extractCreatedMs,
  pickLinuxManifestDigest,
} from "../src/updates/check";

describe("pickLinuxManifestDigest — index/manifest list", () => {
  test("index หลาย arch → เลือก entry แรกที่เป็น linux", () => {
    const index = {
      manifests: [
        { digest: "sha256:amd64", platform: { os: "linux", architecture: "amd64" } },
        { digest: "sha256:arm64", platform: { os: "linux", architecture: "arm64" } },
      ],
    };
    expect(pickLinuxManifestDigest(index)).toBe("sha256:amd64");
  });

  test("ข้าม architecture unknown (attestation ของ buildkit) แม้อยู่ก่อน", () => {
    const index = {
      manifests: [
        { digest: "sha256:attest", platform: { os: "linux", architecture: "unknown" } },
        { digest: "sha256:real", platform: { os: "linux", architecture: "amd64" } },
      ],
    };
    expect(pickLinuxManifestDigest(index)).toBe("sha256:real");
  });

  test("ข้าม os ที่ไม่ใช่ linux", () => {
    const index = {
      manifests: [
        { digest: "sha256:win", platform: { os: "windows", architecture: "amd64" } },
        { digest: "sha256:linux", platform: { os: "linux", architecture: "arm64" } },
      ],
    };
    expect(pickLinuxManifestDigest(index)).toBe("sha256:linux");
  });

  test("manifest เดี่ยว (ไม่มี manifests[]) → null ให้ caller ใช้ตัวมันเองต่อ", () => {
    const single = {
      config: { digest: "sha256:cfg" },
      layers: [{ digest: "sha256:layer" }],
    };
    expect(pickLinuxManifestDigest(single)).toBeNull();
  });

  test("index ที่ไม่มี entry ใช้ได้เลย → null", () => {
    expect(
      pickLinuxManifestDigest({
        manifests: [{ digest: "sha256:a", platform: { os: "linux", architecture: "unknown" } }],
      }),
    ).toBeNull();
    expect(pickLinuxManifestDigest({ manifests: [] })).toBeNull();
  });

  test("JSON เพี้ยน → null ไม่ throw", () => {
    expect(pickLinuxManifestDigest(null)).toBeNull();
    expect(pickLinuxManifestDigest("junk")).toBeNull();
    expect(pickLinuxManifestDigest({ manifests: "not-array" })).toBeNull();
    expect(pickLinuxManifestDigest({ manifests: [null, 42] })).toBeNull();
    // entry ถูก platform แต่ digest หาย/ผิดชนิด → ข้ามไป ไม่พัง
    expect(
      pickLinuxManifestDigest({
        manifests: [{ platform: { os: "linux", architecture: "amd64" } }],
      }),
    ).toBeNull();
    expect(
      pickLinuxManifestDigest({
        manifests: [{ digest: 123, platform: { os: "linux", architecture: "amd64" } }],
      }),
    ).toBeNull();
  });
});

describe("extractConfigDigest — manifest เดี่ยว", () => {
  test("มี config.digest → คืน digest", () => {
    expect(extractConfigDigest({ config: { digest: "sha256:cfg" } })).toBe("sha256:cfg");
  });

  test("โครงสร้างไม่ตรงที่คาด → null", () => {
    expect(extractConfigDigest({})).toBeNull();
    expect(extractConfigDigest({ config: {} })).toBeNull();
    expect(extractConfigDigest({ config: { digest: "" } })).toBeNull();
    expect(extractConfigDigest({ config: { digest: 42 } })).toBeNull();
    expect(extractConfigDigest(null)).toBeNull();
    expect(extractConfigDigest([])).toBeNull();
  });
});

describe("extractCreatedMs — config blob", () => {
  test("created เป็น ISO timestamp → epoch ms", () => {
    expect(extractCreatedMs({ created: "2026-08-20T11:05:00Z" })).toBe(
      Date.parse("2026-08-20T11:05:00Z"),
    );
  });

  test("รองรับ fractional seconds แบบที่ buildkit เขียนจริง", () => {
    const iso = "2026-08-20T11:05:00.123456789Z";
    const ms = extractCreatedMs({ created: iso });
    expect(ms).not.toBeNull();
    expect(new Date(ms as number).getUTCFullYear()).toBe(2026);
  });

  test("ไม่มี created หรือ parse ไม่ได้ → null", () => {
    expect(extractCreatedMs({})).toBeNull();
    expect(extractCreatedMs({ created: "not-a-date" })).toBeNull();
    expect(extractCreatedMs({ created: 1700000000000 })).toBeNull();
    expect(extractCreatedMs(null)).toBeNull();
    expect(extractCreatedMs("junk")).toBeNull();
  });
});
