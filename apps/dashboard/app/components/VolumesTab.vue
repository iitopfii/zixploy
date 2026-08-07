<script setup lang="ts">
/**
 * Volumes Tab — Phase 7
 *
 * List, create, detach, delete (with typed confirm)
 * ลบตรงๆ ไม่ได้ถ้า lifecycle='active' — ต้อง detach ก่อน
 */
const props = defineProps<{ projectId: string; archived: boolean }>();

const api = useApi();

// ---------------------------------------------------------------------------
// Volume type
// ---------------------------------------------------------------------------

interface Volume {
  id: string;
  displayName: string;
  dockerName: string;
  mountPath: string;
  accessMode: "shared-safe" | "single-writer";
  driver: string;
  readOnly: boolean;
  lifecycle: "active" | "detached" | "deletion_pending" | "deleted" | "error";
  lastAttachedAt: number | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const volumes = ref<Volume[]>([]);
const loading = ref(true);
const loadError = ref("");

async function fetchVolumes() {
  loadError.value = "";
  try {
    const { data, error } = await api.api.v1.projects({ id: props.projectId }).volumes.get();
    if (error) {
      loadError.value = "โหลด volumes ไม่ได้";
      return;
    }
    volumes.value = (data?.volumes ?? []).filter((v) => v.lifecycle !== "deleted") as Volume[];
  } catch {
    loadError.value = "ติดต่อ API ไม่ได้";
  } finally {
    loading.value = false;
  }
}

await fetchVolumes();

// ---------------------------------------------------------------------------
// Create form
// ---------------------------------------------------------------------------

const showCreate = ref(false);
const createForm = reactive({
  displayName: "",
  mountPath: "",
  accessMode: "shared-safe" as "shared-safe" | "single-writer",
  readOnly: false,
});
const createError = ref("");
const creating = ref(false);

async function createVolume() {
  creating.value = true;
  createError.value = "";
  try {
    const { error } = await api.api.v1.projects({ id: props.projectId }).volumes.post({
      displayName: createForm.displayName.trim(),
      mountPath: createForm.mountPath.trim(),
      accessMode: createForm.accessMode,
      readOnly: createForm.readOnly,
    });
    if (error) {
      createError.value =
        (error.value as { error?: { message?: string } } | null)?.error?.message ??
        "สร้าง volume ไม่สำเร็จ";
      return;
    }
    showCreate.value = false;
    createForm.displayName = "";
    createForm.mountPath = "";
    await fetchVolumes();
  } catch {
    createError.value = "ติดต่อ API ไม่ได้";
  } finally {
    creating.value = false;
  }
}

// ---------------------------------------------------------------------------
// Detach
// ---------------------------------------------------------------------------

const detachingId = ref<string | null>(null);
const detachError = ref<Record<string, string>>({});

async function detach(volumeId: string) {
  detachingId.value = volumeId;
  detachError.value[volumeId] = "";
  try {
    const { error } = await api.api.v1
      .projects({ id: props.projectId })
      .volumes({ volumeId })
      .detach.post({});
    if (error) {
      detachError.value[volumeId] =
        (error.value as { error?: { message?: string } } | null)?.error?.message ??
        "detach ไม่สำเร็จ";
      return;
    }
    await fetchVolumes();
  } catch {
    detachError.value[volumeId] = "ติดต่อ API ไม่ได้";
  } finally {
    detachingId.value = null;
  }
}

// ---------------------------------------------------------------------------
// Delete (with typed confirm)
// ---------------------------------------------------------------------------

const confirmDeleteId = ref<string | null>(null);
const confirmInput = ref("");
const deleting = ref(false);
const deleteError = ref("");

const confirmTarget = computed(() => volumes.value.find((v) => v.id === confirmDeleteId.value));

const canDelete = computed(() => confirmInput.value === confirmTarget.value?.displayName);

function openDelete(v: Volume) {
  confirmDeleteId.value = v.id;
  confirmInput.value = "";
  deleteError.value = "";
}

async function deleteVolume() {
  if (!confirmDeleteId.value || !canDelete.value) return;
  deleting.value = true;
  deleteError.value = "";
  try {
    const { error } = await api.api.v1
      .projects({ id: props.projectId })
      .volumes({ volumeId: confirmDeleteId.value })
      .delete();
    if (error) {
      deleteError.value =
        (error.value as { error?: { message?: string } } | null)?.error?.message ?? "ลบไม่สำเร็จ";
      return;
    }
    confirmDeleteId.value = null;
    await fetchVolumes();
  } catch {
    deleteError.value = "ติดต่อ API ไม่ได้";
  } finally {
    deleting.value = false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lcClass(lc: string) {
  if (lc === "active") return "lc-active";
  if (lc === "error") return "lc-error";
  if (lc === "deletion_pending") return "lc-del";
  return "lc-other";
}

function fmtTime(ms: number | null) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" });
}
</script>

<template>
  <div class="volumes-tab">
    <div class="tab-header">
      <h2 class="section-title">Volumes</h2>
      <button v-if="!archived" class="primary small" @click="showCreate = !showCreate">
        {{ showCreate ? 'ยกเลิก' : '+ สร้าง volume' }}
      </button>
    </div>

    <!-- Create form -->
    <div v-if="showCreate" class="create-panel">
      <div class="form-row">
        <label class="form-label">ชื่อ</label>
        <input v-model="createForm.displayName" class="form-input" placeholder="my-data" />
      </div>
      <div class="form-row">
        <label class="form-label">Mount path</label>
        <input v-model="createForm.mountPath" class="form-input code" placeholder="/app/data" />
      </div>
      <div class="form-row">
        <label class="form-label">Access mode</label>
        <select v-model="createForm.accessMode" class="form-select">
          <option value="shared-safe">shared-safe (แนะนำ)</option>
          <option value="single-writer">single-writer (⚠️ downtime ระหว่าง deploy)</option>
        </select>
      </div>
      <label class="check-label">
        <input type="checkbox" v-model="createForm.readOnly" />
        Read-only mount
      </label>
      <p v-if="createError" class="error-text small">{{ createError }}</p>
      <button
        class="primary small"
        :disabled="creating || !createForm.displayName.trim() || !createForm.mountPath.trim()"
        @click="createVolume"
      >{{ creating ? 'กำลังสร้าง…' : 'สร้าง' }}</button>
    </div>

    <p v-if="loading" class="muted">กำลังโหลด…</p>
    <p v-else-if="loadError" class="error-text">{{ loadError }}</p>
    <p v-else-if="volumes.length === 0" class="muted">ยังไม่มี volume</p>

    <!-- Volume list -->
    <ul v-else class="vol-list">
      <li v-for="v in volumes" :key="v.id" class="vol-item">
        <div class="vol-header">
          <strong>{{ v.displayName }}</strong>
          <span class="badge" :class="lcClass(v.lifecycle)">{{ v.lifecycle }}</span>
          <span v-if="v.readOnly" class="badge badge-ro">read-only</span>
        </div>

        <dl class="vol-meta">
          <dt>Mount path</dt><dd><code>{{ v.mountPath }}</code></dd>
          <dt>Docker name</dt><dd><code class="muted small">{{ v.dockerName }}</code></dd>
          <dt>Access mode</dt><dd>{{ v.accessMode }}</dd>
          <dt>Last attached</dt><dd>{{ fmtTime(v.lastAttachedAt) }}</dd>
        </dl>

        <p v-if="v.lifecycle === 'error'" class="warn-text small">
          ⚠️ Docker volume หายไป — อาจถูกลบด้วยมือ ดู runbook สำหรับ recovery
        </p>
        <p v-if="v.lifecycle === 'deletion_pending'" class="muted small">
          ⏳ รอ worker ลบ Docker volume จริง…
        </p>

        <p v-if="detachError[v.id]" class="error-text small">{{ detachError[v.id] }}</p>

        <div v-if="!archived" class="vol-actions">
          <button
            v-if="v.lifecycle === 'active'"
            class="secondary small"
            :disabled="detachingId === v.id"
            @click="detach(v.id)"
          >{{ detachingId === v.id ? 'กำลัง detach…' : 'Detach' }}</button>

          <button
            v-if="v.lifecycle !== 'deletion_pending'"
            class="danger small"
            :disabled="v.lifecycle === 'active'"
            :title="v.lifecycle === 'active' ? 'ต้อง detach ก่อนลบ' : ''"
            @click="openDelete(v)"
          >ลบ</button>
        </div>

        <!-- Typed delete confirm -->
        <div v-if="confirmDeleteId === v.id" class="confirm-delete">
          <p class="warn-text small">
            พิมพ์ชื่อ volume <strong>{{ v.displayName }}</strong> เพื่อยืนยันการลบ
          </p>
          <p class="muted small">⚠️ ข้อมูลใน volume จะหายถาวร — ไม่สามารถกู้คืนได้</p>
          <input
            v-model="confirmInput"
            class="form-input"
            placeholder="ชื่อ volume"
            @keydown.enter="deleteVolume"
          />
          <p v-if="deleteError" class="error-text small">{{ deleteError }}</p>
          <div class="confirm-actions">
            <button class="danger small" :disabled="!canDelete || deleting" @click="deleteVolume">
              {{ deleting ? 'กำลังลบ…' : 'ยืนยันลบ' }}
            </button>
            <button class="secondary small" @click="confirmDeleteId = null; confirmInput = ''">ยกเลิก</button>
          </div>
        </div>
      </li>
    </ul>

    <p class="muted small note">
      ℹ️ volume จะถูก mount ทุกครั้งที่ deploy — redeploy เพื่อให้การเปลี่ยนแปลงมีผล
    </p>
  </div>
</template>

<style scoped>
.volumes-tab { display: flex; flex-direction: column; gap: 0.75rem; }
.tab-header { display: flex; align-items: center; justify-content: space-between; }
.section-title { margin: 0; font-size: 1rem; font-weight: 600; }

.create-panel {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.form-row { display: flex; align-items: center; gap: 0.75rem; }
.form-label { min-width: 110px; font-size: 0.875rem; color: var(--muted); }
.form-input {
  flex: 1;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--fg);
  font-size: 0.9rem;
}
.form-input.code { font-family: monospace; }
.form-select {
  flex: 1;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--fg);
  font-size: 0.875rem;
}
.check-label { display: flex; align-items: center; gap: 0.5rem; font-size: 0.875rem; }

.vol-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.vol-item {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.75rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.vol-header { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.badge { font-size: 0.7rem; padding: 0.15rem 0.45rem; border-radius: 999px; font-weight: 600; }
.lc-active { background: #d1fae5; color: #065f46; }
.lc-error { background: #fee2e2; color: #991b1b; }
.lc-del { background: #fef9c3; color: #854d0e; }
.lc-other { background: var(--border); color: var(--muted); }
.badge-ro { background: var(--border); color: var(--muted); }

.vol-meta {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 0.3rem 0.75rem;
  font-size: 0.85rem;
  margin: 0;
}
dt { color: var(--muted); }
dd { margin: 0; }

.vol-actions { display: flex; gap: 0.5rem; }
.warn-text { color: var(--warn); margin: 0; }

.confirm-delete {
  border-top: 1px solid var(--border);
  padding-top: 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.confirm-actions { display: flex; gap: 0.5rem; }

.note { margin-top: 0.25rem; }

@media (prefers-color-scheme: dark) {
  .lc-active { background: #064e3b; color: #6ee7b7; }
  .lc-error { background: #7f1d1d; color: #fca5a5; }
  .lc-del { background: #713f12; color: #fde68a; }
}
:root[data-theme="dark"] .lc-active { background: #064e3b; color: #6ee7b7; }
:root[data-theme="dark"] .lc-error { background: #7f1d1d; color: #fca5a5; }
:root[data-theme="dark"] .lc-del { background: #713f12; color: #fde68a; }
</style>
