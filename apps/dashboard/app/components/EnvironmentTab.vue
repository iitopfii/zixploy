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
  <div class="stack-lg">
    <div class="row-between">
      <h2 class="section-title">Environment Variables</h2>
      <button v-if="!archived" class="secondary small" @click="showImport = !showImport">
        <AppIcon :name="showImport ? 'x' : 'copy'" :size="13" />
        {{ showImport ? "ปิด" : "Import .env" }}
      </button>
    </div>

    <!-- Import panel -->
    <div v-if="showImport" class="inset stack">
      <p class="muted small">วาง .env content (KEY=VALUE) — ตรวจสอบก่อน save</p>
      <textarea
        v-model="importContent"
        class="mono"
        placeholder="DB_HOST=localhost&#10;API_KEY=secret"
        rows="6"
      />
      <p v-if="importError" class="alert alert-bad small">
        <AppIcon name="alert" :size="13" />
        <span>{{ importError }}</span>
      </p>
      <div class="actions">
        <button class="primary small" :disabled="importing || !importContent.trim()" @click="importDotEnv">
          <span v-if="importing" class="spinner" />
          {{ importing ? "กำลัง parse…" : "Parse & Merge" }}
        </button>
        <button
          class="secondary small"
          @click="showImport = false; importContent = ''; importError = ''"
        >
          ยกเลิก
        </button>
      </div>
    </div>

    <div v-if="loading" class="stack">
      <span class="skeleton" style="height: 36px" />
      <span class="skeleton" style="height: 36px" />
    </div>
    <p v-else-if="loadError" class="alert alert-bad">
      <AppIcon name="alert" :size="15" />
      <span>{{ loadError }}</span>
    </p>

    <!-- Editor -->
    <template v-else>
      <div v-if="rows.length > 0" class="env-grid">
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
            class="mono"
            placeholder="KEY"
            :disabled="archived"
            @input="onRowChange"
          />
          <input
            v-model="row.value"
            :type="row.isSecret ? 'password' : 'text'"
            :placeholder="row.isExisting ? '(ไม่เปลี่ยน)' : 'value'"
            :disabled="archived"
            @input="onRowChange"
          />
          <select v-model="row.scope" :disabled="archived" @change="onRowChange">
            <option value="runtime">runtime</option>
            <option value="build">build</option>
            <option value="both">both</option>
          </select>
          <input
            v-model="row.isSecret"
            type="checkbox"
            title="Secret"
            :disabled="archived"
            @change="onRowChange"
          />
          <input
            v-model="row.enabled"
            type="checkbox"
            title="Enabled"
            :disabled="archived"
            @change="onRowChange"
          />
          <button
            v-if="!archived"
            class="danger tiny icon"
            title="ลบแถวนี้"
            aria-label="ลบแถวนี้"
            @click="removeRow(i)"
          >
            <AppIcon name="x" :size="12" />
          </button>
          <span v-else />
        </div>
      </div>

      <p v-if="rows.length === 0 && !dirty" class="muted small">ยังไม่มี environment variables</p>

      <div class="row-between wrap env-footer">
        <button v-if="!archived" class="secondary small" @click="addRow">
          <AppIcon name="plus" :size="13" />
          เพิ่ม variable
        </button>
        <div class="row wrap save-area">
          <p v-if="saveError" class="alert alert-bad small">
            <AppIcon name="alert" :size="13" />
            <span>{{ saveError }}</span>
          </p>
          <p v-if="saveOk" class="alert alert-ok small">
            <AppIcon name="check" :size="13" />
            <span>บันทึกแล้ว</span>
          </p>
          <button v-if="dirty && !archived" class="secondary small" @click="initRows">ยกเลิก</button>
          <button v-if="!archived" class="primary" :disabled="saving || !dirty" @click="save">
            <span v-if="saving" class="spinner" />
            {{ saving ? "กำลังบันทึก…" : "บันทึก" }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.env-grid {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}

.env-grid-head,
.env-grid-row {
  display: grid;
  grid-template-columns: 1fr 1fr 92px 44px 40px 28px;
  gap: var(--s-2);
  align-items: center;
}
.env-grid-head {
  padding: 0 var(--s-2);
  font-size: var(--t-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.env-grid-row input[type="checkbox"] {
  justify-self: center;
}

.env-footer {
  margin-top: var(--s-2);
}
.save-area {
  align-items: center;
}

@media (max-width: 720px) {
  .env-grid-head {
    display: none;
  }
  .env-grid-row {
    grid-template-columns: 1fr;
    gap: var(--s-1);
    padding: var(--s-3);
    background: var(--surface-2);
    border-radius: var(--r);
    margin-bottom: var(--s-2);
  }
}
</style>
