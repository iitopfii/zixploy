/**
 * sweepDockerInventory — snapshot รายชื่อ container/image ลง DB (หน้า Docker)
 *
 * ครอบคลุม: insert รอบแรก, full-replace รอบถัดไป (ตัวที่หายจาก docker ต้องหายจากตาราง),
 * fail-soft (docker คืนว่างทั้งคู่ → คง snapshot เดิม), การตรวจ is_managed ทั้ง container/image
 */

import { describe, expect, test } from "bun:test";
import { loadMigrations, migrateUp, migrationsDir, openDatabase } from "@zixploy/db";
import type { DockerCliClient } from "../src/docker/cli-client";
import type { ContainerPsEntry, ImageLsEntry } from "../src/docker/types";
import { sweepDockerInventory } from "../src/inventory/loop";

function makeDb() {
  const db = openDatabase({ path: ":memory:" });
  migrateUp(db, loadMigrations(migrationsDir()));
  return db;
}

function psEntry(overrides: Partial<ContainerPsEntry> = {}): ContainerPsEntry {
  return {
    ID: "abc123def456",
    Names: "my-app",
    Image: "nginx:1.27-alpine",
    State: "running",
    Status: "Up 2 hours",
    Ports: "80/tcp",
    Labels: "",
    Networks: "bridge",
    CreatedAt: "2026-08-13 10:00:00 +0700 ICT",
    ...overrides,
  };
}

function imgEntry(overrides: Partial<ImageLsEntry> = {}): ImageLsEntry {
  return {
    ID: "sha1234567890",
    Repository: "nginx",
    Tag: "1.27-alpine",
    Size: "43MB",
    CreatedSince: "2 weeks ago",
    ...overrides,
  };
}

function mockDocker(containers: ContainerPsEntry[], images: ImageLsEntry[]): DockerCliClient {
  return {
    listAllContainers: async () => containers,
    listAllImages: async () => images,
  } as unknown as DockerCliClient;
}

function rows(db: ReturnType<typeof makeDb>, table: "docker_containers" | "docker_images") {
  return db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
}

describe("sweepDockerInventory", () => {
  test("รอบแรก: เขียน container + image ครบ พร้อม captured_at เดียวกัน", async () => {
    const db = makeDb();
    const ok = await sweepDockerInventory(db, mockDocker([psEntry()], [imgEntry()]), 1_000_000);
    expect(ok).toBe(true);

    const cs = rows(db, "docker_containers");
    const is = rows(db, "docker_images");
    expect(cs).toHaveLength(1);
    expect(is).toHaveLength(1);
    expect(cs[0]?.name).toBe("my-app");
    expect(cs[0]?.state).toBe("running");
    expect(cs[0]?.captured_at).toBe(1_000_000);
    expect(is[0]?.repository).toBe("nginx");
    expect(is[0]?.captured_at).toBe(1_000_000);
  });

  test("รอบถัดไปเป็น full-replace — container ที่หายจาก docker หายจากตาราง", async () => {
    const db = makeDb();
    await sweepDockerInventory(
      db,
      mockDocker(
        [psEntry({ ID: "aaa", Names: "one" }), psEntry({ ID: "bbb", Names: "two" })],
        [imgEntry()],
      ),
    );
    expect(rows(db, "docker_containers")).toHaveLength(2);

    // รอบสอง: เหลือ container เดียว (two ถูกลบไปแล้ว)
    await sweepDockerInventory(
      db,
      mockDocker([psEntry({ ID: "aaa", Names: "one" })], [imgEntry()]),
    );
    const cs = rows(db, "docker_containers");
    expect(cs).toHaveLength(1);
    expect(cs[0]?.name).toBe("one");
  });

  test("docker คืนว่างทั้งคู่ (daemon ล่ม) → ไม่เขียนทับ snapshot เดิม", async () => {
    const db = makeDb();
    await sweepDockerInventory(db, mockDocker([psEntry()], [imgEntry()]));
    const ok = await sweepDockerInventory(db, mockDocker([], []));
    expect(ok).toBe(false);
    // snapshot เดิมยังอยู่
    expect(rows(db, "docker_containers")).toHaveLength(1);
    expect(rows(db, "docker_images")).toHaveLength(1);
  });

  test("is_managed: platform label / ชื่อตาม convention / image namespace zixploy", async () => {
    const db = makeDb();
    await sweepDockerInventory(
      db,
      mockDocker(
        [
          psEntry({ ID: "c1", Names: "zx-abc-def", Labels: "" }),
          psEntry({ ID: "c2", Names: "zixploy-traefik", Labels: "" }),
          psEntry({ ID: "c3", Names: "custom", Labels: "platform.project_id=x,other=y" }),
          psEntry({ ID: "c4", Names: "user-own-app", Labels: "com.example=1" }),
        ],
        [
          imgEntry({ ID: "i1", Repository: "zixploy/01abc" }),
          imgEntry({ ID: "i2", Repository: "nginx" }),
        ],
      ),
    );

    const managedByName = Object.fromEntries(
      rows(db, "docker_containers").map((r) => [r.name, r.is_managed]),
    );
    expect(managedByName["zx-abc-def"]).toBe(1);
    expect(managedByName["zixploy-traefik"]).toBe(1);
    expect(managedByName.custom).toBe(1);
    expect(managedByName["user-own-app"]).toBe(0);

    const managedByRepo = Object.fromEntries(
      rows(db, "docker_images").map((r) => [r.repository, r.is_managed]),
    );
    expect(managedByRepo["zixploy/01abc"]).toBe(1);
    expect(managedByRepo.nginx).toBe(0);
  });
});
