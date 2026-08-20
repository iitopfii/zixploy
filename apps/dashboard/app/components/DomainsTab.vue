<script setup lang="ts">
/**
 * Domains Tab — Phase 5 (+ M5: custom TLS certificate, Cloudflare-aware DNS)
 *
 * List + add + edit + delete domains, DNS check, TLS certificate management
 * + โหมด "TLS จัดการโดย proxy ภายนอก" (UI preset — ปิด HTTPS/redirect เมื่อรันหลัง
 *   proxy ที่ terminate TLS เอง กัน redirect วนซ้ำ)
 *
 * หลักการออกแบบ: ทุกสถานะที่ผู้ใช้เห็นต้องบอก "แล้วต้องทำอะไรต่อ" ไม่ใช่แค่รายงานผล
 * โดยเฉพาะ DNS ที่ผู้ใช้ต้องไปตั้งค่าที่ registrar ซึ่งอยู่นอกระบบเรา — ถ้าบอกแค่ว่า
 * "mismatch" ผู้ใช้ไม่รู้ว่าต้องสร้าง record อะไร ชี้ไปที่ IP ไหน
 */
const props = defineProps<{ projectId: string; archived: boolean }>();

const api = useApi();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Domain {
  id: string;
  hostname: string;
  internalPort: number;
  httpsEnabled: boolean;
  redirectHttp: boolean;
  redirectMode: string;
  dnsStatus: string;
  dnsCheckedAt: number | null;
  tlsMode: string;
  tlsCertFingerprint: string | null;
  tlsCertNotAfter: number | null;
  enabled: boolean;
}

interface CheckResult {
  status: string;
  resolved: string[];
  cloudflare: string[];
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const domains = ref<Domain[]>([]);
const loading = ref(true);
const loadError = ref("");

/**
 * IP ของ server ที่ผู้ใช้ต้องชี้ DNS มา — ได้จาก response ของ DNS check
 * (control-api อ่านจาก ZIXPLOY_PUBLIC_IPS) เก็บไว้แสดงในคู่มือตั้ง DNS
 */
const serverIps = ref<string[]>([]);

async function fetchDomains() {
  loadError.value = "";
  try {
    const { data, error } = await api.api.v1.projects({ id: props.projectId }).domains.get();
    if (error) {
      loadError.value = "โหลด domains ไม่ได้";
      return;
    }
    domains.value = (data?.domains ?? []) as Domain[];
  } catch {
    loadError.value = "ติดต่อ API ไม่ได้";
  } finally {
    loading.value = false;
  }
}

await fetchDomains();

// ---------------------------------------------------------------------------
// Add form
// ---------------------------------------------------------------------------

const showAdd = ref(false);
const addForm = reactive({
  hostname: "",
  internalPort: 3000,
  httpsEnabled: true,
  redirectHttp: true,
  externalProxy: false,
});
const addError = ref("");
const adding = ref(false);

/**
 * preset "TLS จัดการโดย proxy ภายนอก" — ตัวช่วยตั้งค่าใน UI ล้วน ๆ ไม่มี field ใหม่ใน API
 *
 * ที่มา: ผู้ใช้รัน Zixploy หลัง Nginx Proxy Manager / load balancer ที่ terminate TLS
 * แล้ว forward เป็น HTTP เข้ามา — ถ้า domain ยังเปิด HTTPS + redirect ไว้ Traefik จะเห็น
 * ทุก request เป็น HTTP แล้วสั่ง redirect ไม่รู้จบ (ERR_TOO_MANY_REDIRECTS)
 *
 * ติ๊ก → บังคับปิด HTTPS + redirect (ให้ proxy เป็นคนจัดการ TLS แทน)
 * เอาติ๊กออก → กลับค่าเริ่มต้น เปิด HTTPS + redirect ตามปกติ
 */
function applyExternalProxyPreset(form: {
  httpsEnabled: boolean;
  redirectHttp: boolean;
  externalProxy: boolean;
}) {
  if (form.externalProxy) {
    form.httpsEnabled = false;
    form.redirectHttp = false;
  } else {
    form.httpsEnabled = true;
    form.redirectHttp = true;
  }
}

function errMessage(error: unknown, fallback: string): string {
  const value = (error as { value?: { error?: { message?: string } } } | null)?.value;
  return value?.error?.message ?? fallback;
}

async function addDomain() {
  adding.value = true;
  addError.value = "";
  try {
    const { error } = await api.api.v1.projects({ id: props.projectId }).domains.post({
      hostname: addForm.hostname.trim(),
      internalPort: addForm.internalPort,
      httpsEnabled: addForm.httpsEnabled,
      redirectHttp: addForm.redirectHttp,
    });
    if (error) {
      addError.value = errMessage(error, "เพิ่ม domain ไม่สำเร็จ");
      return;
    }
    showAdd.value = false;
    addForm.hostname = "";
    await fetchDomains();
  } catch {
    addError.value = "ติดต่อ API ไม่ได้";
  } finally {
    adding.value = false;
  }
}

// ---------------------------------------------------------------------------
// Edit HTTPS settings (inline panel ต่อ domain — ใช้ PATCH field เดิม)
// ---------------------------------------------------------------------------

const editPanelId = ref<string | null>(null);
const editForm = reactive({ httpsEnabled: true, redirectHttp: true, externalProxy: false });
const editError = ref("");
const editSaving = ref(false);

function toggleEditPanel(d: Domain) {
  if (editPanelId.value === d.id) {
    editPanelId.value = null;
    return;
  }
  editPanelId.value = d.id;
  editForm.httpsEnabled = d.httpsEnabled;
  editForm.redirectHttp = d.redirectHttp;
  // อนุมานสถานะติ๊กจากค่าเดิม: ปิดทั้ง HTTPS และ redirect = ท่าเดียวกับโหมด proxy ภายนอก
  editForm.externalProxy = !d.httpsEnabled && !d.redirectHttp;
  editError.value = "";
}

async function saveHttpsSettings(domainId: string) {
  editSaving.value = true;
  editError.value = "";
  try {
    const { error } = await api.api.v1
      .projects({ id: props.projectId })
      .domains({ domainId })
      .patch({
        httpsEnabled: editForm.httpsEnabled,
        // ปิด HTTPS แล้ว redirect ไม่มีความหมาย — ส่ง false ไปด้วยให้ค่าใน DB สอดคล้อง
        // กับที่ผู้ใช้เห็น (และให้การอนุมานติ๊ก proxy ภายนอกรอบหน้าไม่เพี้ยน)
        redirectHttp: editForm.httpsEnabled ? editForm.redirectHttp : false,
      });
    if (error) {
      editError.value = errMessage(error, "บันทึกไม่สำเร็จ");
      return;
    }
    editPanelId.value = null;
    await fetchDomains();
  } catch {
    editError.value = "ติดต่อ API ไม่ได้";
  } finally {
    editSaving.value = false;
  }
}

// ---------------------------------------------------------------------------
// DNS check
// ---------------------------------------------------------------------------

const checkingId = ref<string | null>(null);
const checkResults = ref<Record<string, CheckResult>>({});

async function checkDns(domainId: string) {
  checkingId.value = domainId;
  try {
    const { data, error } = await api.api.v1
      .projects({ id: props.projectId })
      .domains({ domainId })
      .check.post({});
    if (error) return;

    checkResults.value[domainId] = {
      status: data?.domain?.dnsStatus ?? "unknown",
      resolved: data?.check?.resolvedAddresses ?? [],
      cloudflare: data?.check?.cloudflareAddresses ?? [],
    };
    if (data?.check?.configuredIps?.length) serverIps.value = data.check.configuredIps;
    await fetchDomains();
  } finally {
    checkingId.value = null;
  }
}

// ---------------------------------------------------------------------------
// DNS status presentation
// ---------------------------------------------------------------------------

/**
 * แปลง dns_status เป็นข้อความที่บอกได้ว่าต้องทำอะไรต่อ
 *
 * "proxied" ไม่ใช่ปัญหา — Cloudflare proxy ซ่อน origin IP เป็นเรื่องปกติและตั้งใจ
 * (ก่อน M5 สถานะนี้ถูกรายงานเป็น mismatch ทำให้ผู้ใช้เข้าใจผิดว่าตั้ง DNS ผิด)
 */
const DNS_PRESENTATION: Record<
  string,
  { tone: string; icon: IconName; label: string; hint: string }
> = {
  valid: {
    tone: "tone-ok",
    icon: "check",
    label: "ชี้มาที่ server แล้ว",
    hint: "domain พร้อมรับ traffic",
  },
  proxied: {
    tone: "tone-info",
    icon: "shield",
    label: "ผ่าน Cloudflare",
    hint: "Cloudflare proxy เปิดอยู่ — DDoS protection ทำงาน traffic วิ่งผ่าน Cloudflare มาที่ server นี้",
  },
  mismatch: {
    tone: "tone-bad",
    icon: "x",
    label: "ชี้ไปที่อื่น",
    hint: "A record ปัจจุบันไม่ได้ชี้มาที่ server นี้ และไม่ใช่ Cloudflare — แก้ที่ผู้ให้บริการ DNS",
  },
  unknown: {
    tone: "tone-warn",
    icon: "info",
    label: "resolve ไม่ได้",
    hint: "ยังไม่มี DNS record หรือ propagate ไม่เสร็จ (รอ 5–30 นาทีหลังสร้าง record)",
  },
  pending: {
    tone: "tone-idle",
    icon: "clock",
    label: "ยังไม่ได้ตรวจ",
    hint: 'กด "ตรวจ DNS" เพื่อตรวจสอบ',
  },
};

/** ชื่อ icon ที่ AppIcon รองรับ — ใช้จำกัด type ของ DNS_PRESENTATION.icon ให้ตรงกับ set จริง */
type IconName = "check" | "shield" | "x" | "info" | "clock";

const FALLBACK_DNS_PRESENTATION = DNS_PRESENTATION.unknown as (typeof DNS_PRESENTATION)[string];

function dns(status: string) {
  return DNS_PRESENTATION[status] ?? FALLBACK_DNS_PRESENTATION;
}

/**
 * ความเสี่ยง redirect วนซ้ำ: DNS ชี้ผ่าน proxy/CDN (proxied) หรือชี้ไปที่อื่น (mismatch
 * — อาจเป็น load balancer ที่เราตรวจไม่รู้จัก) แต่ยังเปิด HTTPS/redirect ฝั่งเราอยู่
 * ถ้า proxy นั้น terminate TLS แล้ว forward เป็น HTTP เข้ามา จะเกิด redirect ไม่รู้จบ
 * — เตือนไว้ก่อนเพราะผู้ใช้ไม่มีทางรู้จาก UI เดิมว่าต้องปิดสองสวิตช์นี้
 */
function riskProxyRedirectLoop(d: Domain): boolean {
  return (
    (d.dnsStatus === "proxied" || d.dnsStatus === "mismatch") && (d.httpsEnabled || d.redirectHttp)
  );
}

// ---------------------------------------------------------------------------
// TLS certificate
// ---------------------------------------------------------------------------

const certPanelId = ref<string | null>(null);
const certForm = reactive({ certificate: "", privateKey: "" });
const certError = ref("");
const certSaving = ref(false);

function openCertPanel(domainId: string) {
  certPanelId.value = domainId;
  certForm.certificate = "";
  certForm.privateKey = "";
  certError.value = "";
}

async function uploadCertificate(domainId: string) {
  certSaving.value = true;
  certError.value = "";
  try {
    const { error } = await api.api.v1
      .projects({ id: props.projectId })
      .domains({ domainId })
      .certificate.put({
        certificate: certForm.certificate.trim(),
        privateKey: certForm.privateKey.trim(),
      });
    if (error) {
      certError.value = errMessage(error, "อัปโหลด certificate ไม่สำเร็จ");
      return;
    }
    certPanelId.value = null;
    certForm.certificate = "";
    certForm.privateKey = "";
    await fetchDomains();
  } catch {
    certError.value = "ติดต่อ API ไม่ได้";
  } finally {
    certSaving.value = false;
  }
}

const removingCertId = ref<string | null>(null);

async function removeCertificate(domainId: string) {
  removingCertId.value = domainId;
  try {
    await api.api.v1.projects({ id: props.projectId }).domains({ domainId }).certificate.delete();
    await fetchDomains();
  } finally {
    removingCertId.value = null;
  }
}

const DAY_MS = 86_400_000;
/** เตือนล่วงหน้า 30 วัน — ตรงกับ CERT_EXPIRY_WARNING_DAYS ใน @zixploy/shared */
const CERT_WARNING_DAYS = 30;

function certDaysLeft(notAfter: number | null): number | null {
  if (!notAfter) return null;
  return Math.floor((notAfter - Date.now()) / DAY_MS);
}

/**
 * custom cert ไม่ต่ออายุอัตโนมัติ (ต่างจาก Let's Encrypt) — ผู้ใช้ต้องอัปโหลดใบใหม่เอง
 * ก่อนหมดอายุ ถ้าไม่เตือน browser จะขึ้น warning ให้ผู้เข้าเว็บโดยที่เจ้าของไม่รู้ตัว
 */
function certTone(daysLeft: number | null): string {
  if (daysLeft === null) return "muted";
  if (daysLeft < 0) return "bad";
  if (daysLeft <= CERT_WARNING_DAYS) return "warn";
  return "ok";
}

function certExpiryText(daysLeft: number | null): string {
  if (daysLeft === null) return "";
  if (daysLeft < 0) return `หมดอายุแล้ว ${-daysLeft} วัน — อัปโหลดใบใหม่`;
  if (daysLeft === 0) return "หมดอายุวันนี้ — อัปโหลดใบใหม่";
  if (daysLeft <= CERT_WARNING_DAYS) return `เหลืออีก ${daysLeft} วัน — เตรียมอัปโหลดใบใหม่`;
  return `เหลืออีก ${daysLeft} วัน`;
}

// ---------------------------------------------------------------------------
// Toggle / delete
// ---------------------------------------------------------------------------

async function toggleEnabled(d: Domain) {
  try {
    await api.api.v1.projects({ id: props.projectId }).domains({ domainId: d.id }).patch({
      enabled: !d.enabled,
    });
    await fetchDomains();
  } catch {
    /* ignore — สถานะจริงมาจาก fetchDomains รอบถัดไปอยู่แล้ว */
  }
}

const confirmDeleteId = ref<string | null>(null);
const deleting = ref(false);
const deleteError = ref("");

async function deleteDomain(domainId: string) {
  deleting.value = true;
  deleteError.value = "";
  try {
    const { error } = await api.api.v1
      .projects({ id: props.projectId })
      .domains({ domainId })
      .delete();
    if (error) {
      deleteError.value = errMessage(error, "ลบไม่สำเร็จ");
      return;
    }
    confirmDeleteId.value = null;
    await fetchDomains();
  } catch {
    deleteError.value = "ติดต่อ API ไม่ได้";
  } finally {
    deleting.value = false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtChecked(ms: number | null) {
  if (!ms) return "ยังไม่เคยตรวจ";
  return new Date(ms).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" });
}

/** fingerprint เต็มยาว 95 ตัวอักษร — ตัดให้พออ่านยืนยันได้โดยไม่ล้นบรรทัด */
function shortFingerprint(fp: string | null): string {
  if (!fp) return "";
  const clean = fp.replace(/:/g, "");
  return `${clean.slice(0, 8)}…${clean.slice(-8)}`.toUpperCase();
}

const copiedIp = ref(false);
async function copyIp(ip: string) {
  try {
    await navigator.clipboard.writeText(ip);
    copiedIp.value = true;
    setTimeout(() => {
      copiedIp.value = false;
    }, 1500);
  } catch {
    /* clipboard ถูกบล็อกใน context ที่ไม่ใช่ https — ผู้ใช้เลือกข้อความเองได้ */
  }
}
</script>

<template>
  <div class="stack-lg">
    <div class="row-between wrap">
      <div>
        <h2 class="section-title">Domains</h2>
        <p class="muted small subtitle">ชี้ domain มาที่ server นี้แล้วเลือกวิธีจัดการ HTTPS</p>
      </div>
      <button v-if="!archived" class="primary small" @click="showAdd = !showAdd">
        <AppIcon :name="showAdd ? 'x' : 'plus'" :size="14" />
        {{ showAdd ? "ยกเลิก" : "เพิ่ม domain" }}
      </button>
    </div>

    <!-- DNS setup hint — แสดง IP ที่ผู้ใช้ต้องชี้มา หลังตรวจ DNS ครั้งแรก -->
    <div v-if="serverIps.length > 0" class="alert alert-info hint-box">
      <AppIcon name="globe" :size="15" />
      <span class="muted">สร้าง A record ชี้มาที่</span>
      <code class="ip-code">{{ serverIps[0] }}</code>
      <button class="ghost tiny" @click="copyIp(serverIps[0] as string)">
        <AppIcon :name="copiedIp ? 'check' : 'copy'" :size="12" />
        {{ copiedIp ? "คัดลอกแล้ว" : "คัดลอก" }}
      </button>
      <span class="muted tiny">เปิด Cloudflare proxy ได้ — ระบบรองรับ</span>
    </div>

    <!-- Add form -->
    <div v-if="showAdd" class="inset stack">
      <label>
        <span>Hostname</span>
        <input v-model="addForm.hostname" placeholder="app.example.com" @keydown.enter="addDomain" />
      </label>
      <label class="short-field">
        <span>Port ของ container</span>
        <input v-model.number="addForm.internalPort" type="number" min="1" max="65535" />
      </label>
      <div class="form-checks">
        <div class="check-row">
          <input
            id="dom-https"
            v-model="addForm.httpsEnabled"
            type="checkbox"
            :disabled="addForm.externalProxy"
          />
          <label for="dom-https">เปิด HTTPS</label>
        </div>
        <div class="check-row">
          <input
            id="dom-redirect"
            v-model="addForm.redirectHttp"
            type="checkbox"
            :disabled="!addForm.httpsEnabled || addForm.externalProxy"
          />
          <label for="dom-redirect">บังคับ HTTP → HTTPS</label>
        </div>
      </div>
      <div class="check-row">
        <input
          id="dom-ext-proxy"
          v-model="addForm.externalProxy"
          type="checkbox"
          @change="applyExternalProxyPreset(addForm)"
        />
        <label for="dom-ext-proxy">
          TLS จัดการโดย proxy ภายนอก (เช่น Nginx Proxy Manager, Cloudflare, load balancer)
        </label>
      </div>
      <p v-if="addForm.externalProxy" class="muted tiny proxy-note">
        proxy ภายนอกเป็นคน terminate TLS — Zixploy จะเสิร์ฟ HTTP ให้ proxy ตรง ๆ
        (การเปิด HTTPS/redirect ที่นี่จะทำให้เกิด redirect วนซ้ำ)
      </p>
      <p v-if="addError" class="alert alert-bad small">
        <AppIcon name="alert" :size="13" />
        <span>{{ addError }}</span>
      </p>
      <button
        class="primary small"
        style="align-self: flex-start"
        :disabled="adding || !addForm.hostname.trim()"
        @click="addDomain"
      >
        <span v-if="adding" class="spinner" />
        {{ adding ? "กำลังเพิ่ม…" : "เพิ่ม domain" }}
      </button>
    </div>

    <div v-if="loading" class="stack">
      <span class="skeleton" style="height: 130px" />
      <span class="skeleton" style="height: 130px" />
    </div>
    <p v-else-if="loadError" class="alert alert-bad">
      <AppIcon name="alert" :size="15" />
      <span>{{ loadError }}</span>
    </p>
    <div v-else-if="domains.length === 0" class="empty">
      <span class="empty-icon"><AppIcon name="globe" :size="20" /></span>
      <span class="empty-title">ยังไม่มี domain</span>
      <p class="small">เพิ่ม domain เพื่อรับ traffic จากภายนอก</p>
    </div>

    <!-- Domain list -->
    <ul v-else class="domain-list">
      <li v-for="d in domains" :key="d.id" class="card domain-card" :class="{ disabled: !d.enabled }">
        <!-- Header: hostname + badges -->
        <div class="card-head">
          <div class="title-line">
            <strong class="hostname truncate">{{ d.hostname }}</strong>
            <span class="muted small mono">:{{ d.internalPort }}</span>
          </div>
          <div class="badges">
            <span v-if="d.httpsEnabled" class="badge tone-ok">
              <AppIcon name="lock" :size="11" />
              HTTPS
            </span>
            <span v-else class="badge">HTTP</span>
            <span v-if="!d.enabled" class="badge">ปิดอยู่</span>
          </div>
        </div>

        <!-- DNS status -->
        <div class="status-line">
          <span class="badge" :class="dns(d.dnsStatus).tone">
            <AppIcon :name="dns(d.dnsStatus).icon" :size="12" />
            {{ dns(d.dnsStatus).label }}
          </span>
          <span class="muted tiny">ตรวจล่าสุด {{ fmtChecked(d.dnsCheckedAt) }}</span>
        </div>
        <p class="muted tiny hint">{{ dns(d.dnsStatus).hint }}</p>
        <p v-if="checkResults[d.id]?.resolved?.length" class="muted tiny mono">
          resolve ได้: {{ checkResults[d.id]?.resolved.join(", ") }}
        </p>

        <!-- เตือนความเสี่ยง redirect วนซ้ำเมื่อ DNS ผ่าน proxy/CDN แต่ยังเปิด HTTPS/redirect -->
        <p v-if="riskProxyRedirectLoop(d)" class="alert alert-warn small">
          <AppIcon name="alert" :size="13" />
          <span>
            DNS ของ domain นี้ชี้ผ่าน proxy/CDN — ถ้า TLS ถูก terminate ที่ proxy
            การเปิด HTTPS/Redirect ที่นี่จะทำให้ redirect วนซ้ำ
            พิจารณาใช้โหมด "TLS จัดการโดย proxy ภายนอก" ในปุ่มตั้งค่า HTTPS
          </span>
        </p>

        <!-- TLS -->
        <div v-if="d.httpsEnabled" class="tls-section">
          <div class="tls-head">
            <span class="tls-label">ใบรับรอง TLS</span>
            <span class="badge" :class="d.tlsMode === 'custom' ? 'tone-info' : 'tone-ok'">
              {{ d.tlsMode === "custom" ? "ใบรับรองของคุณ" : "Let's Encrypt (อัตโนมัติ)" }}
            </span>
          </div>

          <p v-if="d.tlsMode === 'letsencrypt'" class="muted tiny">
            ระบบขอและต่ออายุใบรับรองให้อัตโนมัติ — ต้องให้ port 80 เข้าถึงได้จากภายนอก
          </p>

          <div v-else class="cert-info">
            <div class="cert-row">
              <span class="muted tiny">fingerprint</span>
              <code class="tiny mono">{{ shortFingerprint(d.tlsCertFingerprint) }}</code>
            </div>
            <div class="cert-row">
              <span class="muted tiny">หมดอายุ</span>
              <span class="tiny" :class="`${certTone(certDaysLeft(d.tlsCertNotAfter))}-text`">
                {{ certExpiryText(certDaysLeft(d.tlsCertNotAfter)) }}
              </span>
            </div>
            <p class="muted tiny">ใบรับรองที่อัปโหลดเองไม่ต่ออายุอัตโนมัติ — ต้องอัปโหลดใบใหม่ก่อนหมดอายุ</p>
          </div>

          <div v-if="!archived" class="tls-actions">
            <button class="secondary tiny" @click="openCertPanel(d.id)">
              <AppIcon name="key" :size="12" />
              {{ d.tlsMode === "custom" ? "เปลี่ยนใบรับรอง" : "อัปโหลดใบรับรองเอง" }}
            </button>
            <button
              v-if="d.tlsMode === 'custom'"
              class="ghost tiny"
              :disabled="removingCertId === d.id"
              @click="removeCertificate(d.id)"
            >
              <span v-if="removingCertId === d.id" class="spinner" />
              {{ removingCertId === d.id ? "กำลังลบ…" : "กลับไปใช้ Let's Encrypt" }}
            </button>
          </div>

          <!-- Upload panel -->
          <div v-if="certPanelId === d.id" class="inset stack cert-panel">
            <p class="muted tiny">
              วาง PEM ทั้งสองช่อง — ใบรับรองต้องครอบ <code>{{ d.hostname }}</code>
              และ private key ต้องไม่มี passphrase
            </p>
            <label class="stack-sm">
              <span class="tiny">Certificate (full chain)</span>
              <textarea
                v-model="certForm.certificate"
                class="mono"
                rows="5"
                placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----"
                spellcheck="false"
              />
            </label>
            <label class="stack-sm">
              <span class="tiny">Private key</span>
              <textarea
                v-model="certForm.privateKey"
                class="mono"
                rows="5"
                placeholder="-----BEGIN PRIVATE KEY-----&#10;…&#10;-----END PRIVATE KEY-----"
                spellcheck="false"
              />
            </label>
            <p v-if="certError" class="alert alert-bad small">
              <AppIcon name="alert" :size="13" />
              <span>{{ certError }}</span>
            </p>
            <div class="confirm-actions">
              <button
                class="primary small"
                :disabled="certSaving || !certForm.certificate.trim() || !certForm.privateKey.trim()"
                @click="uploadCertificate(d.id)"
              >
                <span v-if="certSaving" class="spinner" />
                {{ certSaving ? "กำลังบันทึก…" : "บันทึกใบรับรอง" }}
              </button>
              <button class="secondary small" @click="certPanelId = null">ยกเลิก</button>
            </div>
          </div>
        </div>

        <!-- Actions -->
        <div v-if="!archived" class="card-actions">
          <button class="secondary small" :disabled="checkingId === d.id" @click="checkDns(d.id)">
            <span v-if="checkingId === d.id" class="spinner" />
            <AppIcon v-else name="refresh" :size="13" />
            {{ checkingId === d.id ? "กำลังตรวจ…" : "ตรวจ DNS" }}
          </button>
          <button class="secondary small" @click="toggleEditPanel(d)">
            <AppIcon name="settings" :size="13" />
            ตั้งค่า HTTPS
          </button>
          <button class="secondary small" @click="toggleEnabled(d)">
            {{ d.enabled ? "ปิดใช้งาน" : "เปิดใช้งาน" }}
          </button>
          <button class="danger small" @click="confirmDeleteId = d.id">
            <AppIcon name="trash" :size="13" />
            ลบ
          </button>
        </div>

        <!-- inline แก้ไข HTTPS/redirect — field เดิมของ PATCH ไม่มี field ใหม่ -->
        <div v-if="editPanelId === d.id" class="inset stack edit-panel">
          <div class="form-checks">
            <div class="check-row">
              <input
                :id="`edit-https-${d.id}`"
                v-model="editForm.httpsEnabled"
                type="checkbox"
                :disabled="editForm.externalProxy"
              />
              <label :for="`edit-https-${d.id}`">เปิด HTTPS</label>
            </div>
            <div class="check-row">
              <input
                :id="`edit-redirect-${d.id}`"
                v-model="editForm.redirectHttp"
                type="checkbox"
                :disabled="!editForm.httpsEnabled || editForm.externalProxy"
              />
              <label :for="`edit-redirect-${d.id}`">บังคับ HTTP → HTTPS</label>
            </div>
          </div>
          <div class="check-row">
            <input
              :id="`edit-ext-proxy-${d.id}`"
              v-model="editForm.externalProxy"
              type="checkbox"
              @change="applyExternalProxyPreset(editForm)"
            />
            <label :for="`edit-ext-proxy-${d.id}`">
              TLS จัดการโดย proxy ภายนอก (เช่น Nginx Proxy Manager, Cloudflare, load balancer)
            </label>
          </div>
          <p v-if="editForm.externalProxy" class="muted tiny proxy-note">
            proxy ภายนอกเป็นคน terminate TLS — Zixploy จะเสิร์ฟ HTTP ให้ proxy ตรง ๆ
            (การเปิด HTTPS/redirect ที่นี่จะทำให้เกิด redirect วนซ้ำ)
          </p>
          <p v-if="editError" class="alert alert-bad small">
            <AppIcon name="alert" :size="13" />
            <span>{{ editError }}</span>
          </p>
          <div class="confirm-actions">
            <button class="primary small" :disabled="editSaving" @click="saveHttpsSettings(d.id)">
              <span v-if="editSaving" class="spinner" />
              {{ editSaving ? "กำลังบันทึก…" : "บันทึก" }}
            </button>
            <button class="secondary small" @click="editPanelId = null">ยกเลิก</button>
          </div>
        </div>

        <!-- inline confirm delete -->
        <div v-if="confirmDeleteId === d.id" class="confirm-delete">
          <p class="alert alert-warn small">
            <AppIcon name="alert" :size="13" />
            <span>ลบ domain <strong>{{ d.hostname }}</strong>? traffic ที่เข้ามาจะไม่ถูก route อีก</span>
          </p>
          <p v-if="deleteError" class="alert alert-bad small">
            <AppIcon name="alert" :size="13" />
            <span>{{ deleteError }}</span>
          </p>
          <div class="confirm-actions">
            <button class="danger small" :disabled="deleting" @click="deleteDomain(d.id)">
              <span v-if="deleting" class="spinner" />
              {{ deleting ? "กำลังลบ…" : "ยืนยันลบ" }}
            </button>
            <button
              class="secondary small"
              @click="confirmDeleteId = null; deleteError = ''"
            >
              ยกเลิก
            </button>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.subtitle {
  margin: 0.15rem 0 0;
}

/* ── DNS setup hint ── */
.hint-box {
  align-items: center;
  flex-wrap: wrap;
}
.ip-code {
  background: var(--bg);
  border: 1px solid var(--border);
  padding: 0.1rem 0.4rem;
  border-radius: var(--r-sm);
  color: var(--text);
}

/* ── add form ── */
.short-field {
  max-width: 160px;
}
.form-checks {
  display: flex;
  gap: var(--s-5);
  flex-wrap: wrap;
}
.form-checks .check-row {
  margin-bottom: 0;
}
/* check-row ที่วางเดี่ยวใน panel (inset ใช้ stack gap อยู่แล้ว ไม่ต้องมี margin ซ้ำ) */
.inset > .check-row {
  margin-bottom: 0;
}
/* คำอธิบายใต้ checkbox โหมด proxy ภายนอก */
.proxy-note {
  margin: 0;
  line-height: 1.5;
}

/* ── domain card ── */
.domain-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}
.domain-card {
  gap: var(--s-2);
  display: flex;
  flex-direction: column;
}
.domain-card.disabled {
  opacity: 0.6;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
  flex-wrap: wrap;
}
.title-line {
  display: flex;
  align-items: baseline;
  gap: var(--s-2);
  min-width: 0;
}
.hostname {
  font-size: var(--t-md);
}
.badges {
  display: flex;
  gap: var(--s-2);
}

/* ── status ── */
.status-line {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  flex-wrap: wrap;
}
.hint {
  margin: 0;
  line-height: 1.5;
}

.warn-text {
  color: var(--warn);
}
.bad-text {
  color: var(--bad);
}
.ok-text {
  color: var(--ok);
}

/* ── TLS section ── */
.tls-section {
  margin-top: var(--s-1);
  padding-top: var(--s-3);
  border-top: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.tls-head {
  display: flex;
  align-items: center;
  gap: var(--s-3);
}
.tls-label {
  font-size: var(--t-sm);
  font-weight: 600;
}
.cert-info {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.cert-row {
  display: flex;
  gap: var(--s-3);
  align-items: baseline;
}
.cert-row > span:first-child {
  min-width: 70px;
}
.tls-actions {
  display: flex;
  gap: var(--s-2);
  flex-wrap: wrap;
}
.cert-panel {
  margin-top: var(--s-1);
}
.edit-panel {
  margin-top: var(--s-1);
}

/* ── actions ── */
.card-actions {
  display: flex;
  gap: var(--s-2);
  flex-wrap: wrap;
  margin-top: var(--s-1);
}
.confirm-delete {
  border-top: 1px solid var(--border-subtle);
  margin-top: var(--s-1);
  padding-top: var(--s-3);
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.confirm-actions {
  display: flex;
  gap: var(--s-2);
}
</style>
