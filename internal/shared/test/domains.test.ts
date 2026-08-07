/**
 * validateHostname + buildTraefikLabels tests — docs/phase-05-domains.md M2
 */

import { describe, expect, test } from "bun:test";
import { buildTraefikLabels, validateHostname } from "../src/domains";

// ---------------------------------------------------------------------------
// validateHostname
// ---------------------------------------------------------------------------

describe("validateHostname — valid inputs", () => {
  test("hostname ธรรมดา lowercase", () => {
    expect(validateHostname("example.com")).toBe("example.com");
  });

  test("subdomain", () => {
    expect(validateHostname("sub.example.com")).toBe("sub.example.com");
  });

  test("multi-level subdomain", () => {
    expect(validateHostname("a.b.c.example.com")).toBe("a.b.c.example.com");
  });

  test("normalize uppercase → lowercase", () => {
    expect(validateHostname("Example.COM")).toBe("example.com");
  });

  test("trailing space is trimmed", () => {
    expect(validateHostname("  example.com  ")).toBe("example.com");
  });

  test("IDN hostname → punycode", () => {
    // URL API converts Thai chars to xn-- form
    const result = validateHostname("ก.th");
    expect(result).toMatch(/^xn--/);
  });

  test("hyphen ในชื่อ label", () => {
    expect(validateHostname("my-app.example.com")).toBe("my-app.example.com");
  });
});

describe("validateHostname — scheme rejection", () => {
  test("https:// prefix → throw", () => {
    expect(() => validateHostname("https://example.com")).toThrow(/scheme/i);
  });

  test("http:// prefix → throw", () => {
    expect(() => validateHostname("http://example.com")).toThrow(/scheme/i);
  });
});

describe("validateHostname — path/query/fragment rejection", () => {
  test("path → throw", () => {
    expect(() => validateHostname("example.com/path")).toThrow(/path/i);
  });

  test("query string → throw", () => {
    expect(() => validateHostname("example.com?foo=bar")).toThrow(/query/i);
  });

  test("fragment → throw", () => {
    expect(() => validateHostname("example.com#anchor")).toThrow(/fragment/i);
  });
});

describe("validateHostname — wildcard rejection", () => {
  test("wildcard → throw DOMAIN_WILDCARD", () => {
    expect(() => validateHostname("*.example.com")).toThrow(/wildcard/i);
  });
});

describe("validateHostname — port rejection", () => {
  test("example.com:8080 → throw", () => {
    expect(() => validateHostname("example.com:8080")).toThrow(/port/i);
  });
});

describe("validateHostname — IP rejection", () => {
  test("IPv4 → throw", () => {
    expect(() => validateHostname("192.168.1.1")).toThrow(/IP/i);
  });

  test("localhost IP 127.0.0.1 → throw", () => {
    expect(() => validateHostname("127.0.0.1")).toThrow(/IP/i);
  });

  test("IPv6 bracket → throw", () => {
    expect(() => validateHostname("[::1]")).toThrow(/IPv6/i);
  });
});

describe("validateHostname — reserved TLD rejection", () => {
  test("localhost → throw", () => {
    expect(() => validateHostname("app.localhost")).toThrow(/reserved/i);
  });

  test(".local → throw", () => {
    expect(() => validateHostname("myapp.local")).toThrow(/reserved/i);
  });

  test(".internal → throw", () => {
    expect(() => validateHostname("api.internal")).toThrow(/reserved/i);
  });

  test(".test → throw", () => {
    expect(() => validateHostname("app.test")).toThrow(/reserved/i);
  });
});

describe("validateHostname — single-label rejection", () => {
  test("bare hostname (no dot) → throw", () => {
    expect(() => validateHostname("localhost")).toThrow();
  });
});

describe("validateHostname — label format rules", () => {
  test("label ขึ้นต้น hyphen → throw", () => {
    expect(() => validateHostname("-bad.example.com")).toThrow(/hyphen/i);
  });

  test("label ลงท้าย hyphen → throw", () => {
    expect(() => validateHostname("bad-.example.com")).toThrow(/hyphen/i);
  });

  test("empty label (foo..bar) → throw", () => {
    expect(() => validateHostname("foo..bar.com")).toThrow(/label ว่าง/);
  });

  test("empty input → throw", () => {
    expect(() => validateHostname("")).toThrow(/ว่าง/i);
  });
});

// ---------------------------------------------------------------------------
// buildTraefikLabels
// ---------------------------------------------------------------------------

const PROJECT_ID = "01JPROJECT00000000000000001";

describe("buildTraefikLabels — no domains", () => {
  test("empty domains → empty labels", () => {
    expect(buildTraefikLabels([], PROJECT_ID)).toEqual({});
  });
});

describe("buildTraefikLabels — single HTTPS domain", () => {
  test("สร้าง traefik.enable + HTTPS router + TLS + certresolver + service", () => {
    const labels = buildTraefikLabels(
      [
        {
          hostname: "example.com",
          internalPort: 3000,
          httpsEnabled: true,
          redirectHttp: false,
          redirectMode: "none",
        },
      ],
      PROJECT_ID,
    );

    expect(labels["traefik.enable"]).toBe("true");
    expect(labels["traefik.http.routers.example-com.rule"]).toBe("Host(`example.com`)");
    expect(labels["traefik.http.routers.example-com.entrypoints"]).toBe("websecure");
    expect(labels["traefik.http.routers.example-com.tls"]).toBe("true");
    expect(labels["traefik.http.routers.example-com.tls.certresolver"]).toBe("letsencrypt");

    // service port
    const svcName = Object.keys(labels).find((k) => k.includes("loadbalancer.server.port"));
    expect(svcName).toBeTruthy();
    const svcPort = labels[svcName!];
    expect(svcPort).toBe("3000");
  });

  test("ไม่มี HTTP→HTTPS redirect labels ถ้า redirectHttp=false", () => {
    const labels = buildTraefikLabels(
      [
        {
          hostname: "example.com",
          internalPort: 3000,
          httpsEnabled: true,
          redirectHttp: false,
          redirectMode: "none",
        },
      ],
      PROJECT_ID,
    );

    const hasHttpRouter = Object.keys(labels).some((k) => k.includes("-http.entrypoints"));
    expect(hasHttpRouter).toBe(false);
  });
});

describe("buildTraefikLabels — HTTP→HTTPS redirect", () => {
  test("redirectHttp=true → เพิ่ม HTTP router + redirectscheme middleware", () => {
    const labels = buildTraefikLabels(
      [
        {
          hostname: "example.com",
          internalPort: 3000,
          httpsEnabled: true,
          redirectHttp: true,
          redirectMode: "none",
        },
      ],
      PROJECT_ID,
    );

    expect(labels["traefik.http.routers.example-com-http.entrypoints"]).toBe("web");
    expect(labels["traefik.http.routers.example-com-http.rule"]).toBe("Host(`example.com`)");

    const mwKey = Object.keys(labels).find((k) => k.includes("redirectscheme.scheme"));
    expect(mwKey).toBeTruthy();
    expect(labels[mwKey!]).toBe("https");

    const permKey = Object.keys(labels).find((k) => k.includes("redirectscheme.permanent"));
    expect(labels[permKey!]).toBe("true");
  });
});

describe("buildTraefikLabels — HTTP only (no HTTPS)", () => {
  test("httpsEnabled=false → entrypoints=web, ไม่มี tls", () => {
    const labels = buildTraefikLabels(
      [
        {
          hostname: "example.com",
          internalPort: 8080,
          httpsEnabled: false,
          redirectHttp: false,
          redirectMode: "none",
        },
      ],
      PROJECT_ID,
    );

    expect(labels["traefik.http.routers.example-com.entrypoints"]).toBe("web");
    expect(labels["traefik.http.routers.example-com.tls"]).toBeUndefined();
  });
});

describe("buildTraefikLabels — www_to_root redirect", () => {
  test("เพิ่ม router สำหรับ www + redirectregex middleware", () => {
    const labels = buildTraefikLabels(
      [
        {
          hostname: "example.com",
          internalPort: 3000,
          httpsEnabled: true,
          redirectHttp: true,
          redirectMode: "www_to_root",
        },
      ],
      PROJECT_ID,
    );

    // www router
    expect(labels["traefik.http.routers.www-example-com.rule"]).toBe("Host(`www.example.com`)");
    // regex middleware
    const regexKey = Object.keys(labels).find((k) => k.includes("redirectregex.regex"));
    expect(regexKey).toBeTruthy();
    expect(labels[regexKey!]).toContain("www");
    // replacement ชี้ไปที่ root
    const replKey = Object.keys(labels).find((k) => k.includes("redirectregex.replacement"));
    expect(labels[replKey!]).toContain("example.com");
    expect(labels[replKey!]).not.toContain("www.example.com");
  });
});

describe("buildTraefikLabels — root_to_www redirect", () => {
  test("เพิ่ม router สำหรับ root + redirectregex ชี้ไปที่ www", () => {
    const labels = buildTraefikLabels(
      [
        {
          hostname: "example.com",
          internalPort: 3000,
          httpsEnabled: true,
          redirectHttp: false,
          redirectMode: "root_to_www",
        },
      ],
      PROJECT_ID,
    );

    const replKey = Object.keys(labels).find((k) => k.includes("redirectregex.replacement"));
    expect(replKey).toBeTruthy();
    expect(labels[replKey!]).toContain("www.example.com");
  });
});

describe("buildTraefikLabels — multiple domains", () => {
  test("สร้าง router แยกสำหรับแต่ละ domain, service เดียวกัน", () => {
    const labels = buildTraefikLabels(
      [
        {
          hostname: "app.example.com",
          internalPort: 3000,
          httpsEnabled: true,
          redirectHttp: false,
          redirectMode: "none",
        },
        {
          hostname: "api.example.com",
          internalPort: 3000,
          httpsEnabled: true,
          redirectHttp: false,
          redirectMode: "none",
        },
      ],
      PROJECT_ID,
    );

    expect(labels["traefik.http.routers.app-example-com.rule"]).toBe("Host(`app.example.com`)");
    expect(labels["traefik.http.routers.api-example-com.rule"]).toBe("Host(`api.example.com`)");

    // service port key เดียว (service shared per project)
    const portKeys = Object.keys(labels).filter((k) => k.includes("loadbalancer.server.port"));
    // อาจมีหลาย entry แต่ต้องเป็น key ของ service เดียวกัน (same svcName)
    const uniqueServices = new Set(portKeys.map((k) => k.split(".loadbalancer")[0]));
    expect(uniqueServices.size).toBe(1);
  });

  test("traefik.enable=true ถูกสร้างครั้งเดียว ไม่ซ้ำ", () => {
    const labels = buildTraefikLabels(
      [
        {
          hostname: "a.example.com",
          internalPort: 3000,
          httpsEnabled: true,
          redirectHttp: false,
          redirectMode: "none",
        },
        {
          hostname: "b.example.com",
          internalPort: 3000,
          httpsEnabled: true,
          redirectHttp: false,
          redirectMode: "none",
        },
      ],
      PROJECT_ID,
    );

    expect(labels["traefik.enable"]).toBe("true");
    // มี key traefik.enable แค่ตัวเดียว (Record ไม่มี duplicate key)
    const enableKeys = Object.keys(labels).filter((k) => k === "traefik.enable");
    expect(enableKeys.length).toBe(1);
  });
});

describe("buildTraefikLabels — security: no raw user input in label names", () => {
  test("router name derive จาก hostname ที่ normalize แล้ว — ไม่มีอักขระพิเศษ", () => {
    const labels = buildTraefikLabels(
      [
        {
          hostname: "my-app.example.com",
          internalPort: 3000,
          httpsEnabled: true,
          redirectHttp: false,
          redirectMode: "none",
        },
      ],
      PROJECT_ID,
    );

    // ตรวจ key ทั้งหมดไม่มี backtick หรืออักขระพิเศษนอกจาก . - _
    for (const key of Object.keys(labels)) {
      expect(key).toMatch(/^[\w.-]+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// tlsMode — custom certificate (M5)
// ---------------------------------------------------------------------------

describe("buildTraefikLabels — tlsMode", () => {
  function labelsFor(
    tlsMode: "letsencrypt" | "custom" | undefined,
    extra: Partial<Parameters<typeof buildTraefikLabels>[0][number]> = {},
  ) {
    return buildTraefikLabels(
      [
        {
          hostname: "example.com",
          internalPort: 3000,
          httpsEnabled: true,
          redirectHttp: false,
          redirectMode: "none",
          ...(tlsMode ? { tlsMode } : {}),
          ...extra,
        },
      ],
      PROJECT_ID,
    );
  }

  test("ไม่ระบุ tlsMode → letsencrypt (พฤติกรรมเดิมก่อน M5)", () => {
    expect(labelsFor(undefined)["traefik.http.routers.example-com.tls.certresolver"]).toBe(
      "letsencrypt",
    );
  });

  test("tlsMode='letsencrypt' → มี certresolver", () => {
    expect(labelsFor("letsencrypt")["traefik.http.routers.example-com.tls.certresolver"]).toBe(
      "letsencrypt",
    );
  });

  test("tlsMode='custom' → tls=true แต่ **ไม่มี** certresolver", () => {
    // ถ้าใส่ certresolver ตอนใช้ custom cert Traefik จะพยายามขอ ACME cert ทับใบที่อัปโหลดไว้
    const labels = labelsFor("custom");
    expect(labels["traefik.http.routers.example-com.tls"]).toBe("true");
    expect(labels["traefik.http.routers.example-com.tls.certresolver"]).toBeUndefined();
  });

  test("tlsMode='custom' — ไม่มี certresolver ใน label ใดเลย รวม redirect router", () => {
    // www_to_root สร้าง router เพิ่มอีกตัวที่ก็ต้องไม่มี certresolver เช่นกัน
    const labels = labelsFor("custom", { redirectMode: "www_to_root", redirectHttp: true });
    const withResolver = Object.keys(labels).filter((k) => k.includes("certresolver"));
    expect(withResolver).toEqual([]);
  });

  test("tlsMode='letsencrypt' + www_to_root → router ทั้งสองตัวมี certresolver", () => {
    const labels = labelsFor("letsencrypt", { redirectMode: "www_to_root" });
    expect(labels["traefik.http.routers.example-com.tls.certresolver"]).toBe("letsencrypt");
    expect(labels["traefik.http.routers.www-example-com.tls.certresolver"]).toBe("letsencrypt");
  });

  test("tlsMode='custom' + root_to_www → router ทั้งสองตัวไม่มี certresolver แต่มี tls", () => {
    const labels = labelsFor("custom", { redirectMode: "root_to_www" });
    expect(labels["traefik.http.routers.example-com.tls"]).toBe("true");
    expect(labels["traefik.http.routers.example-com-root.tls"]).toBe("true");
    expect(Object.keys(labels).filter((k) => k.includes("certresolver"))).toEqual([]);
  });

  test("httpsEnabled=false → ไม่มี tls label ไม่ว่า tlsMode จะเป็นอะไร", () => {
    const labels = buildTraefikLabels(
      [
        {
          hostname: "example.com",
          internalPort: 3000,
          httpsEnabled: false,
          redirectHttp: false,
          redirectMode: "none",
          tlsMode: "custom",
        },
      ],
      PROJECT_ID,
    );
    expect(Object.keys(labels).filter((k) => k.includes(".tls"))).toEqual([]);
  });

  test("domain หลายตัวที่ใช้ tlsMode ต่างกัน — แยกกันถูกต้อง", () => {
    const labels = buildTraefikLabels(
      [
        {
          hostname: "auto.example.com",
          internalPort: 3000,
          httpsEnabled: true,
          redirectHttp: false,
          redirectMode: "none",
          tlsMode: "letsencrypt",
        },
        {
          hostname: "manual.example.com",
          internalPort: 3000,
          httpsEnabled: true,
          redirectHttp: false,
          redirectMode: "none",
          tlsMode: "custom",
        },
      ],
      PROJECT_ID,
    );
    expect(labels["traefik.http.routers.auto-example-com.tls.certresolver"]).toBe("letsencrypt");
    expect(labels["traefik.http.routers.manual-example-com.tls.certresolver"]).toBeUndefined();
    expect(labels["traefik.http.routers.manual-example-com.tls"]).toBe("true");
  });
});
