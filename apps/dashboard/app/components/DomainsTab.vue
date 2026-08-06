<script setup lang="ts">
/**
 * Domains Tab — Phase 5
 *
 * List + add + edit + delete domains, DNS check
 */
const props = defineProps<{ projectId: string; archived: boolean }>();

const api = useApi();

// ---------------------------------------------------------------------------
// Domain type
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
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const domains = ref<Domain[]>([]);
const loading = ref(true);
const loadError = ref("");

async function fetchDomains() {
  loadError.value = "";
  try {
    const { data, error } = await api.api.v1.projects({ id: props.projectId }).domains.get();
    if (error) { loadError.value = "โหลด domains ไม่ได้"; return; }
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
const addForm = reactive({ hostname: "", internalPort: 80, httpsEnabled: true, redirectHttp: true });
const addError = ref("");
const adding = ref(false);

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
      addError.value = (error.value as { error?: { message?: string } } | null)?.error?.message ?? "เพิ่ม domain ไม่สำเร็จ";
      return;
    }
    showAdd.value = false;
    addForm.hostname = "";
    addForm.internalPort = 80;
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
const checkResults = ref<Record<string, { ok: boolean; msg: string }>>({});

async function checkDns(domainId: string) {
  checkingId.value = domainId;
  try {
    const { data, error } = await api.api.v1.projects({ id: props.projectId })
      .domains({ domainId })
      .check.post({});
    if (error) {
      checkResults.value[domainId] = { ok: false, msg: "ตรวจ DNS ไม่ได้" };
      return;
    }
    const ok = data?.domain?.dnsStatus === "valid";
    checkResults.value[domainId] = {
      ok,
      msg: ok
        ? `✓ ชี้มาถูก (${(data?.check?.resolvedAddresses ?? []).join(", ")})`
        : `✗ ${data?.domain?.dnsStatus} — ยังไม่ชี้มาที่ server`,
    };
    await fetchDomains();
  } catch {
    checkResults.value[domainId] = { ok: false, msg: "ติดต่อ API ไม่ได้" };
  } finally {
    checkingId.value = null;
  }
}

// ---------------------------------------------------------------------------
// Toggle enabled
// ---------------------------------------------------------------------------

async function toggleEnabled(d: Domain) {
  try {
    await api.api.v1.projects({ id: props.projectId }).domains({ domainId: d.id }).patch({
      enabled: !d.enabled,
    });
    await fetchDomains();
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

const confirmDeleteId = ref<string | null>(null);
const deleting = ref(false);
const deleteError = ref("");

async function deleteDomain(domainId: string) {
  deleting.value = true;
  deleteError.value = "";
  try {
    const { error } = await api.api.v1.projects({ id: props.projectId })
      .domains({ domainId })
      .delete();
    if (error) {
      deleteError.value = (error.value as { error?: { message?: string } } | null)?.error?.message ?? "ลบไม่สำเร็จ";
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

function dnsStatusClass(s: string) {
  if (s === "ok") return "dns-ok";
  if (s === "pending") return "dns-pending";
  return "dns-fail";
}

function fmtChecked(ms: number | null) {
  if (!ms) return "ยังไม่เคยตรวจ";
  return new Date(ms).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" });
}
</script>

<template>
  <div class="domains-tab">
    <div class="tab-header">
      <h2 class="section-title">Domains</h2>
      <button v-if="!archived" class="primary small" @click="showAdd = !showAdd">
        {{ showAdd ? 'ยกเลิก' : '+ เพิ่ม domain' }}
      </button>
    </div>

    <!-- Add form -->
    <div v-if="showAdd" class="add-panel">
      <div class="form-row">
        <label class="form-label">Hostname</label>
        <input v-model="addForm.hostname" class="form-input" placeholder="example.com" @keydown.enter="addDomain" />
      </div>
      <div class="form-row">
        <label class="form-label">Internal port</label>
        <input v-model.number="addForm.internalPort" class="form-input short" type="number" min="1" max="65535" />
      </div>
      <div class="form-checks">
        <label><input type="checkbox" v-model="addForm.httpsEnabled" /> HTTPS</label>
        <label><input type="checkbox" v-model="addForm.redirectHttp" :disabled="!addForm.httpsEnabled" /> Redirect HTTP → HTTPS</label>
      </div>
      <p v-if="addError" class="error-text small">{{ addError }}</p>
      <button class="primary small" :disabled="adding || !addForm.hostname.trim()" @click="addDomain">
        {{ adding ? 'กำลังเพิ่ม…' : 'เพิ่ม' }}
      </button>
    </div>

    <p v-if="loading" class="muted">กำลังโหลด…</p>
    <p v-else-if="loadError" class="error-text">{{ loadError }}</p>
    <p v-else-if="domains.length === 0" class="muted">ยังไม่มี domain — เพิ่ม domain เพื่อรับ traffic</p>

    <!-- Domain list -->
    <ul v-else class="domain-list">
      <li v-for="d in domains" :key="d.id" class="domain-item">
        <div class="domain-row">
          <div class="domain-info">
            <strong class="hostname">{{ d.hostname }}</strong>
            <span class="port muted">:{{ d.internalPort }}</span>
            <span v-if="d.httpsEnabled" class="badge-https">HTTPS</span>
            <span v-if="!d.enabled" class="badge-off">ปิด</span>
          </div>

          <div class="domain-meta muted small">
            DNS: <span :class="dnsStatusClass(d.dnsStatus)">{{ d.dnsStatus }}</span>
            · ตรวจล่าสุด: {{ fmtChecked(d.dnsCheckedAt) }}
          </div>

          <div v-if="checkResults[d.id]" class="check-result small" :class="checkResults[d.id]?.ok ? 'ok-text' : 'error-text'">
            {{ checkResults[d.id]?.msg }}
          </div>
        </div>

        <div v-if="!archived" class="domain-actions">
          <button
            class="secondary small"
            :disabled="checkingId === d.id"
            @click="checkDns(d.id)"
          >{{ checkingId === d.id ? 'กำลังตรวจ…' : 'ตรวจ DNS' }}</button>
          <button class="secondary small" @click="toggleEnabled(d)">
            {{ d.enabled ? 'ปิด' : 'เปิด' }}
          </button>
          <button class="danger small" @click="confirmDeleteId = d.id">ลบ</button>
        </div>

        <!-- inline confirm delete -->
        <div v-if="confirmDeleteId === d.id" class="confirm-delete">
          <p class="warn-text small">ลบ domain <strong>{{ d.hostname }}</strong>?</p>
          <p v-if="deleteError" class="error-text small">{{ deleteError }}</p>
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
.domains-tab { display: flex; flex-direction: column; gap: 0.75rem; }
.tab-header { display: flex; align-items: center; justify-content: space-between; }
.section-title { margin: 0; font-size: 1rem; font-weight: 600; }

.add-panel {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.form-row { display: flex; align-items: center; gap: 0.75rem; }
.form-label { min-width: 110px; font-size: 0.875rem; color: var(--muted); }
.form-input { flex: 1; padding: 0.35rem 0.5rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg); color: var(--fg); font-size: 0.9rem; }
.form-input.short { max-width: 100px; flex: none; }
.form-checks { display: flex; gap: 1rem; flex-wrap: wrap; font-size: 0.875rem; }

.domain-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.domain-item {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.75rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.domain-row { display: flex; flex-direction: column; gap: 0.25rem; }
.domain-info { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
.hostname { font-size: 0.95rem; }
.port { font-size: 0.85rem; }
.badge-https { font-size: 0.7rem; padding: 0.1rem 0.4rem; border-radius: 999px; background: var(--accent-bg, #dbeafe); color: var(--accent); }
.badge-off { font-size: 0.7rem; padding: 0.1rem 0.4rem; border-radius: 999px; background: var(--border); color: var(--muted); }
.domain-meta { line-height: 1.4; }
.domain-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.check-result { margin-top: 0.25rem; }
.confirm-delete { border-top: 1px solid var(--border); padding-top: 0.5rem; display: flex; flex-direction: column; gap: 0.35rem; }
.confirm-actions { display: flex; gap: 0.5rem; }
.warn-text { color: var(--warn); margin: 0; }

.dns-ok { color: var(--success, #065f46); font-weight: 600; }
.dns-pending { color: var(--muted); }
.dns-fail { color: var(--error, #991b1b); font-weight: 600; }
</style>
