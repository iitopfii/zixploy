<script setup lang="ts">
/**
 * Environment Tab — Phase 4
 *
 * แสดงรายการ env vars (ไม่มี plaintext ค่า — hasValue: true เท่านั้น)
 * แก้ไขผ่าน editor rows แล้ว PUT ทั้งชุดพร้อมกัน (full replace)
 * Import จาก .env content → parse → merge เข้า editor
 */
const props = defineProps<{ projectId: string; archived: boolean }>();

const api = useApi();

// ---------------------------------------------------------------------------
// Existing vars (metadata only)
// ---------------------------------------------------------------------------

interface EnvMeta {
  id: string;
  key: string;
  isSecret: boolean;
  hasValue: true;
  scope: "runtime" | "build" | "both";
  enabled: boolean;
}

const existingMeta = ref<EnvMeta[]>([]);
const loading = ref(true);
const loadError = ref("");

async function fetchEnv() {
  loadError.value = "";
  try {
    const { data, error } = await api.api.v1.projects({ id: props.projectId }).environment.get();
    if (error) {
      loadError.value = "โหลด env vars ไม่ได้";
      return;
    }
    existingMeta.value = (data?.variables ?? []) as EnvMeta[];
  } catch {
    loadError.value = "ติดต่อ API ไม่ได้";
  } finally {
    loading.value = false;
  }
}

await fetchEnv();

// ---------------------------------------------------------------------------
// Editor state (rows the user is editing)
// ---------------------------------------------------------------------------

interface EditorRow {
  key: string;
  value: string; // new value (empty = keep existing for existing keys)
  isSecret: boolean;
  scope: "runtime" | "build" | "both";
  enabled: boolean;
  isExisting: boolean; // true = has existing encrypted value in DB
}

const rows = ref<EditorRow[]>([]);
const dirty = ref(false);

// Initialise rows from existing metadata (value = "" = keep existing)
function initRows() {
  rows.value = existingMeta.value.map((m) => ({
    key: m.key,
    value: "",
    isSecret: m.isSecret,
    scope: m.scope,
    enabled: m.enabled,
    isExisting: true,
  }));
  dirty.value = false;
}

initRows();

watch(existingMeta, initRows);

function addRow() {
  rows.value.push({
    key: "",
    value: "",
    isSecret: false,
    scope: "runtime",
    enabled: true,
    isExisting: false,
  });
  dirty.value = true;
}

function removeRow(i: number) {
  rows.value.splice(i, 1);
  dirty.value = true;
}

function onRowChange() {
  dirty.value = true;
}

// ---------------------------------------------------------------------------
// Import from .env text
// ---------------------------------------------------------------------------

const showImport = ref(false);
const importContent = ref("");
const importError = ref("");
const importing = ref(false);

async function importDotEnv() {
  importing.value = true;
  importError.value = "";
  try {
    const { data, error } = await api.api.v1
      .projects({ id: props.projectId })
      .environment.import.post({
        content: importContent.value,
      });
    if (error) {
      const msg = (error.value as { error?: { message?: string } } | null)?.error?.message;
      importError.value = msg ?? "parse ไม่ได้";
      return;
    }
    // Merge parsed vars into editor (don't overwrite existing keys that have values)
    const parsed = data?.parsed ?? [];
    for (const v of parsed) {
      const existing = rows.value.find((r) => r.key === v.key);
      if (existing) {
        if (v.value) existing.value = v.value;
      } else {
        rows.value.push({
          key: v.key,
          value: v.value,
          isSecret: false,
          scope: "runtime",
          enabled: true,
          isExisting: false,
        });
      }
    }
    dirty.value = true;
    showImport.value = false;
    importContent.value = "";
    if (data?.warnings?.length) {
      saveError.value = `คำเตือน: ${data.warnings.join(", ")}`;
    }
  } catch {
    importError.value = "ติดต่อ API ไม่ได้";
  } finally {
    importing.value = false;
  }
}

// ---------------------------------------------------------------------------
// Save (PUT full replace)
// ---------------------------------------------------------------------------

const saving = ref(false);
const saveError = ref("");
const saveOk = ref(false);

async function save() {
  saving.value = true;
  saveError.value = "";
  saveOk.value = false;

  // Build the variables array — skip rows that are existing AND have empty value
  // (they will be re-submitted with their existing DB value via the API)
  // Actually: API does full replace — for existing keys with no new value we pass value=""
  // which the API treats as keeping the existing encrypted value (if the key existed before)
  // But our API does FULL REPLACE → we must send all rows even those with empty value
  const variables = rows.value
    .filter((r) => r.key.trim() !== "")
    .map((r) => ({
      key: r.key.trim(),
      value: r.value,
      isSecret: r.isSecret,
      scope: r.scope,
      enabled: r.enabled,
    }));

  try {
    const { error } = await api.api.v1
      .projects({ id: props.projectId })
      .environment.put({ variables });
    if (error) {
      const msg = (error.value as { error?: { message?: string } } | null)?.error?.message;
      saveError.value = msg ?? "บันทึกไม่สำเร็จ";
      return;
    }
    saveOk.value = true;
    dirty.value = false;
    await fetchEnv();
  } catch {
    saveError.value = "ติดต่อ API ไม่ได้";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="env-tab">
    <div class="env-header">
      <h2 class="section-title">Environment Variables</h2>
      <div class="header-actions">
        <button v-if="!archived" class="secondary small" @click="showImport = !showImport">
          {{ showImport ? 'ปิด' : 'Import .env' }}
        </button>
      </div>
    </div>

    <!-- Import panel -->
    <div v-if="showImport" class="import-panel">
      <p class="muted small">วาง .env content (KEY=VALUE) — ตรวจสอบก่อน save</p>
      <textarea
        v-model="importContent"
        class="env-textarea"
        placeholder="DB_HOST=localhost&#10;API_KEY=secret"
        rows="6"
      />
      <p v-if="importError" class="error-text small">{{ importError }}</p>
      <div class="import-actions">
        <button class="primary small" :disabled="importing || !importContent.trim()" @click="importDotEnv">
          {{ importing ? 'กำลัง parse…' : 'Parse & Merge' }}
        </button>
        <button class="secondary small" @click="showImport = false; importContent = ''; importError = ''">ยกเลิก</button>
      </div>
    </div>

    <p v-if="loading" class="muted">กำลังโหลด…</p>
    <p v-else-if="loadError" class="error-text">{{ loadError }}</p>

    <!-- Editor -->
    <template v-else>
      <div class="env-grid-head">
        <span>KEY</span>
        <span>VALUE</span>
        <span>Scope</span>
        <span>Secret</span>
        <span>On</span>
        <span />
      </div>
      <div v-for="(row, i) in rows" :key="i" class="env-grid-row">
        <input
          v-model="row.key"
          class="env-input code"
          placeholder="KEY"
          :disabled="archived"
          @input="onRowChange"
        />
        <input
          v-model="row.value"
          class="env-input"
          :type="row.isSecret ? 'password' : 'text'"
          :placeholder="row.isExisting ? '(ไม่เปลี่ยน)' : 'value'"
          :disabled="archived"
          @input="onRowChange"
        />
        <select v-model="row.scope" class="env-select" :disabled="archived" @change="onRowChange">
          <option value="runtime">runtime</option>
          <option value="build">build</option>
          <option value="both">both</option>
        </select>
        <input type="checkbox" v-model="row.isSecret" :disabled="archived" @change="onRowChange" />
        <input type="checkbox" v-model="row.enabled" :disabled="archived" @change="onRowChange" />
        <button v-if="!archived" class="danger tiny" @click="removeRow(i)">✕</button>
      </div>

      <div class="env-footer">
        <button v-if="!archived" class="secondary small" @click="addRow">+ เพิ่ม variable</button>
        <div class="save-area">
          <p v-if="saveError" class="error-text small">{{ saveError }}</p>
          <p v-if="saveOk" class="ok-text small">✓ บันทึกแล้ว</p>
          <button
            v-if="!archived"
            class="primary"
            :disabled="saving || !dirty"
            @click="save"
          >{{ saving ? 'กำลังบันทึก…' : 'บันทึก' }}</button>
          <button v-if="dirty && !archived" class="secondary small" @click="initRows">ยกเลิก</button>
        </div>
      </div>

      <p v-if="rows.length === 0 && !dirty" class="muted">ยังไม่มี environment variables</p>
    </template>
  </div>
</template>

<style scoped>
.env-tab { display: flex; flex-direction: column; gap: 0.75rem; }
.env-header { display: flex; align-items: center; justify-content: space-between; }
.section-title { margin: 0; font-size: 1rem; font-weight: 600; }
.header-actions { display: flex; gap: 0.5rem; }

.import-panel {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.env-textarea {
  width: 100%;
  font-family: monospace;
  font-size: 0.85rem;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--fg);
  resize: vertical;
  box-sizing: border-box;
}
.import-actions { display: flex; gap: 0.5rem; }

.env-grid-head {
  display: grid;
  grid-template-columns: 1fr 1fr 90px 50px 40px 32px;
  gap: 0.4rem;
  padding: 0 0.25rem;
  font-size: 0.75rem;
  color: var(--muted);
  font-weight: 600;
}
.env-grid-row {
  display: grid;
  grid-template-columns: 1fr 1fr 90px 50px 40px 32px;
  gap: 0.4rem;
  align-items: center;
}
.env-input {
  width: 100%;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.85rem;
  background: var(--bg);
  color: var(--fg);
  box-sizing: border-box;
}
.env-input.code { font-family: monospace; }
.env-select {
  padding: 0.35rem 0.25rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.8rem;
  background: var(--bg);
  color: var(--fg);
}
.env-footer { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-top: 0.5rem; }
.save-area { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
button.tiny { padding: 0.2rem 0.4rem; font-size: 0.75rem; line-height: 1; }
</style>
