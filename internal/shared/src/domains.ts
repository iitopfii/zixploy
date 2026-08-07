/**
 * Domain validation และ Traefik label generation — docs/phase-05-domains.md
 *
 * ฟังก์ชันทั้งหมดนี้ใช้ร่วมกันระหว่าง control-api (validation + CRUD) และ
 * deploy-worker (สร้าง labels ตอน createContainer) ผ่าน @zixploy/shared
 *
 * Security:
 * - validateHostname ห้าม raw scheme/path/query/wildcard/IP/reserved ผ่าน
 * - buildTraefikLabels สร้าง label จาก DB data เท่านั้น — ห้ามรับ raw label จากผู้ใช้ (threat-model.md)
 * - Router/service ชื่อ generate จาก hostname ที่ผ่าน validate แล้ว — ไม่ใช้ user input อื่น
 */

// ---------------------------------------------------------------------------
// Hostname validation
// ---------------------------------------------------------------------------

/** TLD/SLD ที่ถือว่า reserved — ห้ามใช้เป็น public hostname (RFC 2606, RFC 6761) */
const RESERVED_TLDS = new Set([
  "localhost",
  "local",
  "internal",
  "invalid",
  "example",
  "test",
  "home",
  "corp",
  "lan",
  "intranet",
]);

/** ตรวจว่าเป็น IPv4 address */
function isIPv4(s: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(s);
}

/** ตรวจว่าเป็น IPv6 address (bare หรือ bracket-wrapped) */
function isIPv6(s: string): boolean {
  // bracket: [::1], [2001:db8::1]
  if (s.startsWith("[") && s.endsWith("]")) return true;
  // bare: ต้องมี colon อย่างน้อย 2 ตัว (กัน false positive บน port-like strings)
  return (s.match(/:/g) ?? []).length >= 2;
}

/**
 * ตรวจสอบและ normalize hostname
 *
 * รับ: ตัวอักษรทั่วไป เช่น "example.com", "sub.example.com", "ก.ไทย.th"
 * คืน: lowercase/punycode canonical form เช่น "example.com", "xn--o3cw4h.xn--o3cw4h.th"
 *
 * ปฏิเสธ (โยน Error พร้อม message อ่านได้):
 * - มี scheme (://)
 * - มี path (/)
 * - มี query (?)
 * - มี # fragment
 * - มี port (:8080)
 * - wildcard (*)
 * - IP address (IPv4/IPv6)
 * - single-label hostname (เช่น "localhost" เดี่ยวๆ)
 * - reserved TLD (localhost, local, internal, ฯลฯ)
 * - label ยาวเกิน 63 ตัวอักษร
 * - hostname ยาวเกิน 253 ตัวอักษร
 * - label ว่าง (เช่น "foo..bar")
 * - label ขึ้นต้นหรือลงท้ายด้วย hyphen (RFC 1123)
 */
export function validateHostname(raw: string): string {
  const input = raw.trim();

  if (!input) throw new Error("hostname ต้องไม่ว่าง");

  // ห้าม scheme
  if (input.includes("://")) {
    throw new Error(`hostname ต้องไม่มี scheme (เช่น https://) — ส่งเฉพาะ hostname เท่านั้น`);
  }
  // ห้าม path
  if (input.includes("/")) {
    throw new Error(`hostname ต้องไม่มี path — ส่งเฉพาะ hostname เท่านั้น`);
  }
  // ห้าม query
  if (input.includes("?")) {
    throw new Error(`hostname ต้องไม่มี query string`);
  }
  // ห้าม fragment
  if (input.includes("#")) {
    throw new Error(`hostname ต้องไม่มี fragment (#)`);
  }
  // ห้าม wildcard
  if (input.includes("*")) {
    throw new Error(`wildcard hostname ไม่รองรับใน MVP`);
  }

  // แยก port ออก (เช่น example.com:8080)
  const colonIdx = input.lastIndexOf(":");
  if (colonIdx !== -1) {
    const afterColon = input.slice(colonIdx + 1);
    if (/^\d+$/.test(afterColon)) {
      throw new Error(`hostname ต้องไม่มี port — ระบุ port ใน internal_port แทน`);
    }
  }

  // ห้าม IPv4
  if (isIPv4(input)) {
    throw new Error(`IP address ไม่รองรับ — ใช้ hostname เท่านั้น`);
  }
  // ห้าม IPv6
  if (isIPv6(input)) {
    throw new Error(`IPv6 address ไม่รองรับ — ใช้ hostname เท่านั้น`);
  }

  // ใช้ URL API เพื่อ normalize + punycode IDN
  let normalized: string;
  try {
    const url = new URL(`http://${input}`);
    normalized = url.hostname; // lowercase + punycode
  } catch {
    throw new Error(`hostname ไม่ถูกต้อง: "${input}"`);
  }

  // ตรวจ labels
  const labels = normalized.split(".");

  // ต้องมีอย่างน้อย 2 labels (เช่น "example.com" ไม่ใช่ "localhost" เดี่ยวๆ)
  if (labels.length < 2) {
    throw new Error(`hostname ต้องมีอย่างน้อย 2 ส่วน (เช่น "example.com")`);
  }

  // ตรวจ reserved TLD
  const tld = labels[labels.length - 1] ?? "";
  if (RESERVED_TLDS.has(tld)) {
    throw new Error(`TLD "${tld}" เป็น reserved hostname — ใช้ public domain เท่านั้น`);
  }

  // ตรวจแต่ละ label
  for (const label of labels) {
    if (!label) {
      throw new Error(`hostname มี label ว่าง (เช่น "foo..bar")`);
    }
    if (label.length > 63) {
      throw new Error(`แต่ละส่วนของ hostname ต้องไม่ยาวเกิน 63 ตัวอักษร (ได้รับ: "${label}")`);
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      throw new Error(`label ต้องไม่ขึ้นต้นหรือลงท้ายด้วย hyphen: "${label}"`);
    }
  }

  if (normalized.length > 253) {
    throw new Error(`hostname ยาวเกิน 253 ตัวอักษร`);
  }

  return normalized;
}

// ---------------------------------------------------------------------------
// Traefik label generation
// ---------------------------------------------------------------------------

/** สถานะการตรวจ DNS — 'proxied' = ชี้ผ่าน Cloudflare edge (ตั้งใจ ไม่ใช่ error) */
export type DnsStatus = "pending" | "valid" | "mismatch" | "proxied" | "unknown";

/**
 * แหล่งที่มาของ TLS certificate
 * - `letsencrypt`: Traefik ขอ/ต่ออายุเองผ่าน ACME (ต้องให้ port 80 เข้าถึงได้จากภายนอก)
 * - `custom`: ผู้ใช้อัปโหลด PEM เอง — Traefik อ่านจาก file provider (ดู tls/materialize.ts)
 *   ใช้กรณี wildcard, EV cert, หรือ Cloudflare Origin CA (ที่ ACME ออกให้ไม่ได้)
 */
export type TlsMode = "letsencrypt" | "custom";

/** ข้อมูล domain ที่จำเป็นสำหรับสร้าง Traefik labels */
export interface DomainConfig {
  hostname: string;
  internalPort: number;
  httpsEnabled: boolean;
  redirectHttp: boolean;
  redirectMode: "none" | "www_to_root" | "root_to_www";
  /** ไม่ระบุ → 'letsencrypt' (พฤติกรรมเดิมก่อน M5) */
  tlsMode?: TlsMode;
}

/**
 * แปลง hostname ให้เป็น router/service name ที่ปลอดภัยสำหรับ Traefik
 * ใช้เฉพาะ [a-z0-9-] เพราะ Traefik router name ต้องเป็น RFC 1123 DNS label-like
 */
function routerSafeName(hostname: string): string {
  // แทน dot และ underscore ด้วย hyphen, ลบตัวอักษรอื่น
  return hostname
    .toLowerCase()
    .replace(/[._]/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63); // Traefik router name มักไม่เกิน 63 chars
}

/**
 * สร้าง Traefik Docker labels สำหรับ container หนึ่งตัว
 *
 * labels ที่สร้าง (ต่อหนึ่ง domain):
 *   traefik.enable=true (สร้างเพียงครั้งเดียว)
 *   traefik.http.routers.<name>.rule=Host(`<hostname>`)
 *   traefik.http.routers.<name>.entrypoints=websecure
 *   traefik.http.routers.<name>.tls=true
 *   traefik.http.routers.<name>.tls.certresolver=letsencrypt
 *   traefik.http.services.<svcName>.loadbalancer.server.port=<port>
 *
 * HTTP→HTTPS redirect (ถ้า redirectHttp=true):
 *   traefik.http.routers.<name>-http.rule=Host(`<hostname>`)
 *   traefik.http.routers.<name>-http.entrypoints=web
 *   traefik.http.routers.<name>-http.middlewares=<name>-https-redirect
 *   traefik.http.middlewares.<name>-https-redirect.redirectscheme.scheme=https
 *   traefik.http.middlewares.<name>-https-redirect.redirectscheme.permanent=true
 *
 * www/root redirect (ถ้า redirectMode != 'none'):
 *   เพิ่ม router สำหรับ source domain + middleware redirectregex
 *
 * @param domains - รายการ domain ที่ enabled=true เท่านั้น
 * @param projectId - ULID — ใช้สร้าง service name ที่ unique ต่อ project
 * @returns Record<string, string> ที่ใส่ใน createContainer labels ได้ทันที
 */
export function buildTraefikLabels(
  domains: DomainConfig[],
  projectId: string,
): Record<string, string> {
  if (domains.length === 0) return {};

  const labels: Record<string, string> = {
    "traefik.enable": "true",
  };

  // service name unique ต่อ project (ไม่ต่อ deployment — service ชี้ไปที่ port ของ container)
  // ใช้ 12 chars สุดท้ายของ projectId (ULID sortable part) เพื่อให้ unique + อ่านง่าย
  const svcName = `zx-${projectId.slice(-12).toLowerCase()}`;

  /**
   * ตั้ง TLS labels ให้ router หนึ่งตัว
   *
   * `letsencrypt` → ระบุ certresolver ให้ Traefik ไปขอ cert ผ่าน ACME
   * `custom`      → **ห้าม** ใส่ certresolver เด็ดขาด ไม่งั้น Traefik จะพยายามขอ ACME cert
   *                 ทับ cert ที่ผู้ใช้อัปโหลด (ใส่ tls=true เฉย ๆ แล้วให้ file provider
   *                 จับคู่ cert กับ SNI เอง — ดู tls/materialize.ts)
   */
  const applyTls = (routerName: string, tlsMode: TlsMode) => {
    labels[`traefik.http.routers.${routerName}.tls`] = "true";
    if (tlsMode === "letsencrypt") {
      labels[`traefik.http.routers.${routerName}.tls.certresolver`] = "letsencrypt";
    }
  };

  for (const domain of domains) {
    const name = routerSafeName(domain.hostname);
    const tlsMode: TlsMode = domain.tlsMode ?? "letsencrypt";

    if (domain.httpsEnabled) {
      // HTTPS router
      labels[`traefik.http.routers.${name}.rule`] = `Host(\`${domain.hostname}\`)`;
      labels[`traefik.http.routers.${name}.entrypoints`] = "websecure";
      applyTls(name, tlsMode);
      labels[`traefik.http.routers.${name}.service`] = svcName;

      // HTTP → HTTPS redirect
      if (domain.redirectHttp) {
        const mw = `${name}-https-redirect`;
        labels[`traefik.http.routers.${name}-http.rule`] = `Host(\`${domain.hostname}\`)`;
        labels[`traefik.http.routers.${name}-http.entrypoints`] = "web";
        labels[`traefik.http.routers.${name}-http.middlewares`] = mw;
        labels[`traefik.http.middlewares.${mw}.redirectscheme.scheme`] = "https";
        labels[`traefik.http.middlewares.${mw}.redirectscheme.permanent`] = "true";
      }
    } else {
      // HTTP only router (ไม่มี TLS)
      labels[`traefik.http.routers.${name}.rule`] = `Host(\`${domain.hostname}\`)`;
      labels[`traefik.http.routers.${name}.entrypoints`] = "web";
      labels[`traefik.http.routers.${name}.service`] = svcName;
    }

    // www ↔ root redirect (เพิ่ม router แยก + regex middleware)
    if (domain.redirectMode === "www_to_root") {
      // www.example.com → example.com
      const wwwHost = `www.${domain.hostname}`;
      const wwwName = routerSafeName(wwwHost);
      const mw = `${name}-www-to-root`;

      labels[`traefik.http.routers.${wwwName}.rule`] = `Host(\`${wwwHost}\`)`;
      labels[`traefik.http.routers.${wwwName}.entrypoints`] = domain.httpsEnabled
        ? "websecure"
        : "web";
      if (domain.httpsEnabled) applyTls(wwwName, tlsMode);
      labels[`traefik.http.routers.${wwwName}.middlewares`] = mw;
      labels[`traefik.http.middlewares.${mw}.redirectregex.regex`] =
        `^https?://www\\.${escapeRegexDots(domain.hostname)}/(.*)`;
      labels[`traefik.http.middlewares.${mw}.redirectregex.replacement`] =
        `${domain.httpsEnabled ? "https" : "http"}://${domain.hostname}/\${1}`;
      labels[`traefik.http.middlewares.${mw}.redirectregex.permanent`] = "true";
    } else if (domain.redirectMode === "root_to_www") {
      // example.com → www.example.com
      const wwwHost = `www.${domain.hostname}`;
      const mw = `${name}-root-to-www`;
      const rootName = `${name}-root`;

      labels[`traefik.http.routers.${rootName}.rule`] = `Host(\`${domain.hostname}\`)`;
      labels[`traefik.http.routers.${rootName}.entrypoints`] = domain.httpsEnabled
        ? "websecure"
        : "web";
      if (domain.httpsEnabled) applyTls(rootName, tlsMode);
      labels[`traefik.http.routers.${rootName}.middlewares`] = mw;
      labels[`traefik.http.middlewares.${mw}.redirectregex.regex`] =
        `^https?://${escapeRegexDots(domain.hostname)}/(.*)`;
      labels[`traefik.http.middlewares.${mw}.redirectregex.replacement`] =
        `${domain.httpsEnabled ? "https" : "http"}://${wwwHost}/\${1}`;
      labels[`traefik.http.middlewares.${mw}.redirectregex.permanent`] = "true";
    }

    // Service loadbalancer (shared สำหรับทุก domain ใน project — ชี้ไปที่ port เดียวกัน)
    labels[`traefik.http.services.${svcName}.loadbalancer.server.port`] = String(
      domain.internalPort,
    );
  }

  return labels;
}

/** escape dots ใน hostname สำหรับ regex string */
function escapeRegexDots(hostname: string): string {
  return hostname.replace(/\./g, "\\.");
}
