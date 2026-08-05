import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard สำหรับสัญญาสถาปัตยกรรมที่เปลี่ยนภายหลังยาก (ADR-0002, docs/threat-model.md)
 *
 * Control API ต้องไม่มีทางเข้าถึง Docker Engine ไม่ว่าทางใด —
 * การเข้าถึง Docker socket เทียบเท่า root บน host และ API เป็นส่วนที่เผชิญ internet
 * เทสต์นี้จะ fail ทันทีหากมีใครเผลอเพิ่ม dependency หรือ path ของ Docker เข้ามา
 */

const API_SRC = join(import.meta.dir, "..", "src");
const API_PACKAGE_JSON = join(import.meta.dir, "..", "package.json");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("Control API ต้องไม่แตะ Docker (ADR-0002)", () => {
  test("ไม่มี Docker client library ใน dependencies", () => {
    const pkg = JSON.parse(readFileSync(API_PACKAGE_JSON, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });

    const dockerLibs = all.filter((name) =>
      /^(dockerode|docker-|@docker\/|node-docker)/.test(name),
    );
    expect(dockerLibs).toEqual([]);
  });

  test("ไม่มีการอ้างถึง Docker socket หรือ Docker Engine API ใน source", () => {
    const forbidden = [
      "/var/run/docker.sock",
      "docker.sock",
      "dockerode",
      "unix:///var/run",
      "DOCKER_HOST",
    ];

    const offenders: string[] = [];
    for (const file of sourceFiles(API_SRC)) {
      const content = readFileSync(file, "utf8");
      for (const needle of forbidden) {
        if (content.includes(needle)) offenders.push(`${file}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("ไม่ spawn subprocess (docker CLI ก็เข้าถึงไม่ได้)", () => {
    const forbidden = ["Bun.spawn", "child_process", "node:child_process", "execSync"];

    const offenders: string[] = [];
    for (const file of sourceFiles(API_SRC)) {
      const content = readFileSync(file, "utf8");
      for (const needle of forbidden) {
        if (content.includes(needle)) offenders.push(`${file}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("API ต้องไม่ bind public interface (docs/phase-01 security)", () => {
  test("entrypoint listen บน loopback เท่านั้น", () => {
    const entrypoint = readFileSync(join(API_SRC, "index.ts"), "utf8");
    expect(entrypoint).toContain('hostname: "127.0.0.1"');
    expect(entrypoint).not.toContain('hostname: "0.0.0.0"');
  });

  test("entrypoint กำหนด maxRequestBodySize", () => {
    const entrypoint = readFileSync(join(API_SRC, "index.ts"), "utf8");
    expect(entrypoint).toContain("maxRequestBodySize");
  });
});
