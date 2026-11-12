/**
 * imageRegistry + normalizeRegistryHost — เลือก credential ของ registry ให้ถูกตัวตอน pull (0.1.24)
 */

import { describe, expect, test } from "bun:test";
import { imageRegistry, normalizeRegistryHost } from "../src/components";

describe("imageRegistry", () => {
  test.each([
    ["nginx:1.27", "docker.io"],
    ["library/nginx:1.27", "docker.io"],
    ["acme/app:1.0", "docker.io"],
    ["ghcr.io/hype-developer/sealand-api:abc", "ghcr.io"],
    ["GHCR.io/acme/app:1", "ghcr.io"],
    ["registry.example.com:5000/team/app:2", "registry.example.com:5000"],
    ["localhost/app:1", "localhost"],
    ["localhost:5000/app:1", "localhost:5000"],
    ["index.docker.io/library/nginx:1", "docker.io"],
    [`ghcr.io/acme/app@sha256:${"a".repeat(64)}`, "ghcr.io"],
  ])("%p → %p", (ref, host) => {
    expect(imageRegistry(ref)).toBe(host);
  });
});

describe("normalizeRegistryHost", () => {
  test.each([
    ["ghcr.io", "ghcr.io"],
    [" https://GHCR.io/ ", "ghcr.io"],
    ["registry.example.com:5000", "registry.example.com:5000"],
    ["index.docker.io", "docker.io"],
    ["https://index.docker.io/v1/", "docker.io"],
  ])("%p → %p", (input, host) => {
    expect(normalizeRegistryHost(input)).toBe(host);
  });

  test.each(["ghcr.io/acme", "", "bad host", "-ghcr.io"])("ปฏิเสธ %p", (input) => {
    expect(() => normalizeRegistryHost(input)).toThrow();
  });
});
