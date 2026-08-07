<script setup lang="ts">
/**
 * Domains Tab — Phase 5 (+ M5: custom TLS certificate, Cloudflare-aware DNS)
 *
 * List + add + edit + delete domains, DNS check, TLS certificate management
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
});
const addError = ref("");
const adding = ref(false);

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
  { tone: string; icon: string; label: string; hint: string }
> = {
  valid: {
    tone: "ok",
    icon: "✓",
    label: "ชี้มาที่ server แล้ว",
    hint: "domain พร้อมรับ traffic",
  },
  proxied: {
    tone: "info",
    icon: "☁",
    label: "ผ่าน Cloudflare",
    hint: "Cloudflare proxy เปิดอยู่ — DDoS protection ทำงาน traffic วิ่งผ่าน Cloudflare มาที่ server นี้",
  },
  mismatch: {
    tone: "bad",
    icon: "✗",
    label: "ชี้ไปที่อื่น",
    hint: "A record ปัจจุบันไม่ได้ชี้มาที่ server นี้ และไม่ใช่ Cloudflare — แก้ที่ผู้ให้บริการ DNS",
  },
  unknown: {
    tone: "warn",
    icon: "?",
    label: "resolve ไม่ได้",
    hint: "ยังไม่มี DNS record หรือ propagate ไม่เสร็จ (รอ 5–30 นาทีหลังสร้าง record)",
  },
  pending: {
    tone: "muted",
    icon: "•",
    label: "ยังไม่ได้ตรวจ",
    hint: 'กด "ตรวจ DNS" เพื่อตรวจสอบ',
  },
};

function dns(status: string) {
  return DNS_PRESENTATION[status] ?? DNS_PRESENTATION.unknown!;
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
  <div class="domains-tab">
    <div class="tab-header">
      <div>
        <h2 class="section-title">Domains</h2>
        <p class="muted small subtitle">ชี้ domain มาที่ server นี้แล้วเลือกวิธีจัดการ HTTPS</p>
      </div>
      <button v-if="!archived" class="primary small" @click="showAdd = !showAdd">
        {{ showAdd ? 'ยกเลิก' : '+ เพิ่ม domain' }}
      </button>
    </div>

    <!-- DNS setup hint — แสดง IP ที่ผู้ใช้ต้องชี้มา หลังตรวจ DNS ครั้งแรก -->
    <div v-if="serverIps.length > 0" class="hint-box">
      <span class="hint-label">สร้าง A record ชี้มาที่</span>
      <code class="ip-code">{{ serverIps[0] }}</code>
      <button class="ghost tiny" @click="copyIp(serverIps[0] as string)">
        {{ copiedIp ? 'คัดลอกแล้ว' : 'คัดลอก' }}
      </button>
      <span class="muted tiny">เปิด Cloudflare proxy ได้ — ระบบรองรับ</span>
    </div>

    <!-- Add form -->
    <div v-if="showAdd" class="panel">
      <div class="form-row">
        <label class="form-label">Hostname</label>
        <input v-model="addForm.hostname" class="form-input" placeholder="app.example.com" @keydown.enter="addDomain" />
      </div>
      <div class="form-row">
        <label class="form-label">Port ของ container</label>
        <input v-model.number="addForm.internalPort" class="form-input short" type="number" min="1" max="65535" />
      </div>
      <div class="form-checks">
        <label><input v-model="addForm.httpsEnabled" type="checkbox" /> เปิด HTTPS</label>
        <label><input v-model="addForm.redirectHttp" type="checkbox" :disabled="!addForm.httpsEnabled" /> บังคับ HTTP → HTTPS</label>
      </div>
      <p v-if="addError" class="bad-text small">{{ addError }}</p>
      <div>
        <button class="primary small" :disabled="adding || !addForm.hostname.trim()" @click="addDomain">
          {{ adding ? 'กำลังเพิ่ม…' : 'เพิ่ม domain' }}
        </button>
      </div>
    </div>

    <p v-if="loading" class="muted">กำลังโหลด…</p>
    <p v-else-if="loadError" class="bad-text">{{ loadError }}</p>
    <p v-else-if="domains.length === 0" class="muted empty">ยังไม่มี domain — เพิ่ม domain เพื่อรับ traffic จากภายนอก</p>

    <!-- Domain list -->
    <ul v-else class="domain-list">
      <li v-for="d in domains" :key="d.id" class="domain-card" :class="{ disabled: !d.enabled }">
        <!-- Header: hostname + badges -->
        <div class="card-head">
          <div class="title-line">
            <strong class="hostname">{{ d.hostname }}</strong>
            <span class="muted small">→ :{{ d.internalPort }}</span>
          </div>
          <div class="badges">
            <span v-if="d.httpsEnabled" class="badge accent">HTTPS</span>
            <span v-else class="badge">HTTP</span>
            <span v-if="!d.enabled" class="badge">ปิดอยู่</span>
          </div>
        </div>

        <!-- DNS status -->
        <div class="status-line">
          <span class="pill" :class="dns(d.dnsStatus).tone">
            {{ dns(d.dnsStatus).icon }} {{ dns(d.dnsStatus).label }}
          </span>
          <span class="muted tiny">ตรวจล่าสุด {{ fmtChecked(d.dnsCheckedAt) }}</span>
        </div>
        <p class="muted tiny hint">{{ dns(d.dnsStatus).hint }}</p>
        <p v-if="checkResults[d.id]?.resolved?.length" class="muted tiny mono">
          resolve ได้: {{ checkResults[d.id]?.resolved.join(', ') }}
        </p>

        <!-- TLS -->
        <div v-if="d.httpsEnabled" class="tls-section">
          <div class="tls-head">
            <span class="tls-label">ใบรับรอง TLS</span>
            <span class="pill" :class="d.tlsMode === 'custom' ? 'info' : 'ok'">
              {{ d.tlsMode === 'custom' ? 'ใบรับรองของคุณ' : "Let's Encrypt (อัตโนมัติ)" }}
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
              {{ d.tlsMode === 'custom' ? 'เปลี่ยนใบรับรอง' : 'อัปโหลดใบรับรองเอง' }}
            </button>
            <button
              v-if="d.tlsMode === 'custom'"
              class="ghost tiny"
              :disabled="removingCertId === d.id"
              @click="removeCertificate(d.id)"
            >
              {{ removingCertId === d.id ? 'กำลังลบ…' : "กลับไปใช้ Let's Encrypt" }}
            </button>
          </div>

          <!-- Upload panel -->
          <div v-if="certPanelId === d.id" class="panel cert-panel">
            <p class="muted tiny">
              วาง PEM ทั้งสองช่อง — ใบรับรองต้องครอบ <code>{{ d.hostname }}</code>
              และ private key ต้องไม่มี passphrase
            </p>
            <label class="form-label tiny">Certificate (full chain)</label>
            <textarea
              v-model="certForm.certificate"
              class="form-textarea mono"
              rows="5"
              placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----"
              spellcheck="false"
            />
            <label class="form-label tiny">Private key</label>
            <textarea
              v-model="certForm.privateKey"
              class="form-textarea mono"
              rows="5"
              placeholder="-----BEGIN PRIVATE KEY-----&#10;…&#10;-----END PRIVATE KEY-----"
              spellcheck="false"
            />
            <p v-if="certError" class="bad-text small">{{ certError }}</p>
            <div class="confirm-actions">
              <button
                class="primary small"
                :disabled="certSaving || !certForm.certificate.trim() || !certForm.privateKey.trim()"
                @click="uploadCertificate(d.id)"
              >{{ certSaving ? 'กำลังบันทึก…' : 'บันทึกใบรับรอง' }}</button>
              <button class="secondary small" @click="certPanelId = null">ยกเลิก</button>
            </div>
          </div>
        </div>

        <!-- Actions -->
        <div v-if="!archived" class="card-actions">
          <button class="secondary small" :disabled="checkingId === d.id" @click="checkDns(d.id)">
            {{ checkingId === d.id ? 'กำลังตรวจ…' : 'ตรวจ DNS' }}
          </button>
          <button class="secondary small" @click="toggleEnabled(d)">
            {{ d.enabled ? 'ปิดใช้งาน' : 'เปิดใช้งาน' }}
          </button>
          <button class="danger small" @click="confirmDeleteId = d.id">ลบ</button>
        </div>

        <!-- inline confirm delete -->
        <div v-if="confirmDeleteId === d.id" class="confirm-delete">
          <p class="warn-text small">ลบ domain <strong>{{ d.hostname }}</strong>? traffic ที่เข้ามาจะไม่ถูก route อีก</p>
          <p v-if="deleteError" class="bad-text small">{{ deleteError }}</p>
          <div class="confirm-actions">
            <button class="danger small" :disabled="deleting" @click="deleteDomain(d.id)">
              {{ deleting ? 'กำลังลบ…' : 'ยืนยันลบ' }}
            </button>
            <button class="secondary small" @click="confirmDeleteId = null; deleteError = ''">ยกเลิก</button>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.domains-tab { display: flex; flex-direction: column; gap: 0.85rem; }
.tab-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
.section-title { margin: 0; font-size: 1rem; font-weight: 600; }
.subtitle { margin: 0.15rem 0 0; }
.empty { padding: 1.5rem 0; text-align: center; }

.tiny { font-size: 0.75rem; }
.small { font-size: 0.85rem; }
.mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }

/* ── DNS setup hint ────────────────────────────────────────────────── */
.hint-box {
  display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
  padding: 0.6rem 0.85rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  font-size: 0.85rem;
}
.hint-label { color: var(--muted); }
.ip-code {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  background: var(--bg); border: 1px solid var(--border);
  padding: 0.1rem 0.4rem; border-radius: 4px; color: var(--text);
}

/* ── panels / forms ───────────────────────────────────────────────── */
.panel {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 1rem;
  display: flex; flex-direction: column; gap: 0.6rem;
}
.form-row { display: flex; align-items: center; gap: 0.75rem; }
.form-label { min-width: 140px; font-size: 0.85rem; color: var(--muted); }
.form-input {
  flex: 1; padding: 0.4rem 0.55rem;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg); color: var(--text); font-size: 0.9rem;
}
.form-input.short { max-width: 110px; flex: none; }
.form-textarea {
  width: 100%; padding: 0.5rem;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg); color: var(--text);
  font-size: 0.75rem; line-height: 1.4; resize: vertical;
}
.form-checks { display: flex; gap: 1.25rem; flex-wrap: wrap; font-size: 0.85rem; }

/* ── domain card ──────────────────────────────────────────────────── */
.domain-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
.domain-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 0.9rem 1rem;
  display: flex; flex-direction: column; gap: 0.45rem;
}
.domain-card.disabled { opacity: 0.6; }

.card-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
.title-line { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
.hostname { font-size: 0.95rem; }
.badges { display: flex; gap: 0.35rem; }

.badge {
  font-size: 0.7rem; padding: 0.1rem 0.45rem; border-radius: 999px;
  background: var(--bg); border: 1px solid var(--border); color: var(--muted);
}
.badge.accent { color: var(--accent); border-color: var(--accent); }

/* ── status pill ──────────────────────────────────────────────────── */
.status-line { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
.pill {
  font-size: 0.75rem; font-weight: 600;
  padding: 0.15rem 0.55rem; border-radius: 999px;
  border: 1px solid currentColor;
}
.pill.ok    { color: var(--ok); }
.pill.info  { color: var(--accent); }
.pill.warn  { color: var(--warn); }
.pill.bad   { color: var(--bad); }
.pill.muted { color: var(--muted); }
.hint { margin: 0; line-height: 1.5; }

.ok-text    { color: var(--ok); }
.warn-text  { color: var(--warn); }
.bad-text   { color: var(--bad); }
.muted-text { color: var(--muted); }

/* ── TLS section ──────────────────────────────────────────────────── */
.tls-section {
  margin-top: 0.35rem; padding-top: 0.6rem;
  border-top: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 0.45rem;
}
.tls-head { display: flex; align-items: center; gap: 0.6rem; }
.tls-label { font-size: 0.85rem; font-weight: 600; }
.cert-info { display: flex; flex-direction: column; gap: 0.2rem; }
.cert-row { display: flex; gap: 0.6rem; align-items: baseline; }
.cert-row > span:first-child { min-width: 70px; }
.tls-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.cert-panel { margin-top: 0.35rem; }

/* ── actions ──────────────────────────────────────────────────────── */
.card-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.35rem; }
.confirm-delete {
  border-top: 1px solid var(--border); margin-top: 0.35rem; padding-top: 0.6rem;
  display: flex; flex-direction: column; gap: 0.4rem;
}
.confirm-actions { display: flex; gap: 0.5rem; }
</style>
