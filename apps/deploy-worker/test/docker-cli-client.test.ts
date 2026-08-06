/**
 * DockerCliClient integration tests — รันกับ Docker Desktop จริงในเครื่อง (ยืนยันแล้วว่าใช้งานได้
 * ผ่าน `docker`/`docker buildx` CLI ระหว่าง implement M5) ไม่ mock
 *
 * ทุก resource ที่สร้างในเทสต์ติด label เฉพาะแล้วลบทิ้งใน afterAll เสมอ กัน pollution บนเครื่อง dev
 */
import { afterAll, describe, expect, test } from "bun:test";
import { ulid } from "@zixploy/shared";
import { DockerCliClient } from "../src/docker/cli-client";

const client = new DockerCliClient();
const TEST_RUN_ID = ulid();
const testNetworkName = `zx-test-net-${TEST_RUN_ID}`;
const createdContainerIds: string[] = [];

afterAll(async () => {
  for (const id of createdContainerIds) {
    await client.removeContainer(id, { force: true }).catch(() => {});
  }
  // ลบ network ผ่าน docker CLI ตรง ๆ — ไม่ expose removeNetwork ใน client (ไม่มี M6 caller ต้องใช้)
  const proc = Bun.spawn(["docker", "network", "rm", testNetworkName], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
});

describe("DockerCliClient — ping", () => {
  test("daemon จริงพร้อมใช้งาน → true", async () => {
    expect(await client.ping()).toBe(true);
  });

  test("ชี้ dockerHost ไปที่ port ที่ไม่มีอะไร listen → false ไม่ throw", async () => {
    const badClient = new DockerCliClient({
      dockerHost: "tcp://127.0.0.1:1",
      commandTimeoutMs: 10_000,
    });
    expect(await badClient.ping()).toBe(false);
  });
});

describe("DockerCliClient — network", () => {
  test("ensureNetwork: สร้างใหม่แล้ว idempotent เมื่อเรียกซ้ำ", async () => {
    const first = await client.ensureNetwork(testNetworkName);
    expect(typeof first.networkId).toBe("string");
    expect(first.networkId.length).toBeGreaterThan(0);

    const second = await client.ensureNetwork(testNetworkName);
    expect(second.networkId).toBe(first.networkId);
  });
});

describe("DockerCliClient — container lifecycle", () => {
  test("create → inspect → start → inspect (running) → stop → remove", async () => {
    await client.ensureNetwork(testNetworkName);
    const name = `zx-test-container-${TEST_RUN_ID}`;

    const { containerId } = await client.createContainer({
      name,
      image: "hello-world",
      labels: { "platform.managed": "true", "zixploy.test-run": TEST_RUN_ID },
      restartPolicy: "no",
      networkName: testNetworkName,
    });
    createdContainerIds.push(containerId);
    expect(typeof containerId).toBe("string");

    const beforeStart = await client.inspectContainer(containerId);
    expect(beforeStart).not.toBeNull();
    expect(beforeStart?.State.Status).toBe("created");
    expect(beforeStart?.RestartCount).toBe(0);

    await client.startContainer(containerId);
    // hello-world exits immediately after printing — poll briefly for exited state
    let inspected = await client.inspectContainer(containerId);
    for (let i = 0; i < 20 && inspected?.State.Status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 200));
      inspected = await client.inspectContainer(containerId);
    }
    expect(inspected).not.toBeNull();
    expect(["exited", "running"]).toContain(inspected?.State.Status ?? "");

    await client.stopContainer(containerId, { timeoutSec: 2 });
    await client.removeContainer(containerId);

    const afterRemove = await client.inspectContainer(containerId);
    expect(afterRemove).toBeNull();
  });

  test("removeContainer บน container ที่ไม่มีอยู่แล้ว → ไม่ throw (idempotent)", async () => {
    await expect(client.removeContainer(`nonexistent-${ulid()}`)).resolves.toBeUndefined();
  });

  test("stopContainer บน container ที่ไม่มีอยู่แล้ว → ไม่ throw", async () => {
    await expect(client.stopContainer(`nonexistent-${ulid()}`)).resolves.toBeUndefined();
  });

  test("inspectContainer บน container ที่ไม่มีอยู่ → null", async () => {
    expect(await client.inspectContainer(`nonexistent-${ulid()}`)).toBeNull();
  });

  test("listContainersByLabel: กรองด้วย label ของเทสต์นี้เท่านั้น", async () => {
    await client.ensureNetwork(testNetworkName);
    const name = `zx-test-list-${ulid()}`;
    const { containerId } = await client.createContainer({
      name,
      image: "hello-world",
      labels: { "platform.managed": "true", "zixploy.test-run": TEST_RUN_ID },
      restartPolicy: "no",
      networkName: testNetworkName,
    });
    createdContainerIds.push(containerId);

    const found = await client.listContainersByLabel({ "zixploy.test-run": TEST_RUN_ID });
    expect(
      found.some((c) => c.ID === containerId.slice(0, 12) || containerId.startsWith(c.ID)),
    ).toBe(true);
  });

  test("createContainer ปฏิเสธ networkName='host' (safety denylist บังคับใช้จริง)", async () => {
    await expect(
      client.createContainer({
        name: `zx-test-reject-${ulid()}`,
        image: "hello-world",
        labels: { "platform.managed": "true" },
        restartPolicy: "no",
        networkName: "host",
      }),
    ).rejects.toThrow();
  });
});

describe("DockerCliClient — image", () => {
  test("inspectImage บน image ที่มีอยู่จริง (hello-world ถูก pull มาแล้วจากเทสต์ก่อนหน้า)", async () => {
    const info = await client.inspectImage("hello-world");
    expect(info).not.toBeNull();
    expect(info?.Id).toMatch(/^sha256:/);
  });

  test("inspectImage บน image ที่ไม่มีอยู่ → null", async () => {
    // Docker image reference ต้องเป็น lowercase — ulid() คืนตัวพิมพ์ใหญ่ ใช้ toLowerCase()
    expect(
      await client.inspectImage(`nonexistent-image-${ulid().toLowerCase()}:latest`),
    ).toBeNull();
  });

  test("removeImage บน image ที่ไม่มีอยู่ → ไม่ throw (idempotent)", async () => {
    await expect(
      client.removeImage(`nonexistent-image-${ulid().toLowerCase()}:latest`),
    ).resolves.toBeUndefined();
  });
});
