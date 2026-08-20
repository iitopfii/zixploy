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
// Scope selector (Phase 18 · F) — project-wide หรือ env เจาะจง component (compose)
// ---------------------------------------------------------------------------

/** "" = project-wide; ไม่งั้นเป็น componentId */
const scope = ref("");
const components = ref<Array<{ id: string; name: string }>>([]);

async function fetchComponents() {
  try {
    const { data } = await api.api.v1.projects({ id: props.projectId }).components.get();
    components.value = (data?.items ?? []).map((c) => ({ id: c.id, name: c.name }));
  } catch {
    // ไม่ critical — ถ้าโหลดไม่ได้ก็แสดงแค่ project-wide
  }
}
await fetchComponents();

/** query สำหรับ API ตาม scope ที่เลือก (project-wide = ไม่ส่ง componentId) */
function scopeQuery() {
  return scope.value ? { query: { componentId: scope.value } } : undefined;
}

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
    const { data, error } = await api.api.v1
      .projects({ id: props.projectId })
      .environment.get(scopeQuery());
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

// เปลี่ยน scope → โหลด env ของ scope นั้นใหม่ (ทิ้ง edit ที่ยังไม่ save)
watch(scope, () => {
  loading.value = true;
  fetchEnv();
});

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
      .environment.put({ variables }, scopeQuery());
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

// ---------------------------------------------------------------------------
// ตรวจสอบการถอดรหัส — จับเคส master key เปลี่ยน/ciphertext เสียก่อนไปพังตอน deploy
// (ตรวจทุก scope รวม component ในคราวเดียว — server ไม่คืน plaintext ใด ๆ)
// ---------------------------------------------------------------------------

interface BrokenEnvKey {
  key: string;
  componentId: string | null;
}

const checking = ref(false);
const checkError = ref("");
const checkResult = ref<{ total: number; broken: BrokenEnvKey[] } | null>(null);

async function checkDecryption() {
  checking.value = true;
  checkError.value = "";
  checkResult.value = null;
  try {
    const { data, error } = await api.api.v1
      .projects({ id: props.projectId })
      .environment.health.get();
    if (error || !data) {
      checkError.value = "ตรวจสอบไม่สำเร็จ";
      return;
    }
    checkResult.value = { total: data.total, broken: data.broken };
  } catch {
    checkError.value = "ติดต่อ API ไม่ได้";
  } finally {
    checking.value = false;
  }
}

function brokenLabel(b: BrokenEnvKey): string {
  if (!b.componentId) return b.key;
  const name = components.value.find((c) => c.id === b.componentId)?.name ?? b.componentId;
  return `${b.key} (component: ${name})`;
}
</script>

<template>
  <div class="stack-lg">
    <div class="row-between">
      <h2 class="section-title">Environment Variables</h2>
      <div class="row wrap">
        <button
          v-if="!archived"
          class="secondary small"
          :disabled="checking"
          title="ตรวจว่าค่าที่บันทึกไว้ยังถอดรหัสได้ด้วย master key ปัจจุบัน"
          @click="checkDecryption"
        >
          <span v-if="checking" class="spinner" />
          {{ checking ? "กำลังตรวจ…" : "ตรวจสอบการถอดรหัส" }}
        </button>
        <button v-if="!archived" class="secondary small" @click="showImport = !showImport">
          <AppIcon :name="showImport ? 'x' : 'copy'" :size="13" />
          {{ showImport ? "ปิด" : "Import .env" }}
        </button>
      </div>
    </div>

    <!-- ผลตรวจการถอดรหัส -->
    <p v-if="checkError" class="alert alert-bad small">
      <AppIcon name="alert" :size="13" />
      <span>{{ checkError }}</span>
    </p>
    <p v-else-if="checkResult && checkResult.total === 0" class="alert alert-ok small">
      <AppIcon name="check" :size="13" />
      <span>ยังไม่มี environment variable ให้ตรวจ</span>
    </p>
    <p v-else-if="checkResult && checkResult.broken.length === 0" class="alert alert-ok small">
      <AppIcon name="check" :size="13" />
      <span>ตรวจแล้ว {{ checkResult.total }} ตัว — ถอดรหัสได้ทั้งหมด</span>
    </p>
    <div v-else-if="checkResult" class="alert alert-bad small broken-list">
      <AppIcon name="alert" :size="13" />
      <div>
        <p>
          {{ checkResult.broken.length }} จาก {{ checkResult.total }} ตัวถอดรหัสไม่ได้
          (master key อาจเปลี่ยน) — deploy จะไม่ได้ค่าเหล่านี้ กรอกค่าใหม่แล้วบันทึกเพื่อเข้ารหัสใหม่:
        </p>
        <p class="mono">{{ checkResult.broken.map(brokenLabel).join(", ") }}</p>
      </div>
    </div>

    <!-- Scope selector — เฉพาะ compose project ที่มี component (Phase 18 · F) -->
    <label v-if="components.length > 0" class="scope-select">
      <span>ขอบเขต</span>
      <select v-model="scope" :disabled="archived">
        <option value="">ทั้งโปรเจกต์ (project-wide)</option>
        <option v-for="c in components" :key="c.id" :value="c.id">component: {{ c.name }}</option>
      </select>
      <small class="muted">
        {{ scope ? "env นี้ใช้เฉพาะ component ที่เลือก (override ค่าระดับโปรเจกต์)" : "env นี้ใช้กับทุก component" }}
      </small>
    </label>

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

.scope-select {
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
  max-width: 420px;
}
.scope-select select {
  max-width: 320px;
}

.broken-list {
  align-items: flex-start;
}
.broken-list p {
  margin: 0;
}
.broken-list .mono {
  margin-top: var(--s-1);
  word-break: break-word;
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
