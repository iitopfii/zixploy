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
  lastError: string | null;
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

const LIFECYCLE_TONE: Record<string, string> = {
  active: "tone-ok",
  error: "tone-bad",
  deletion_pending: "tone-warn",
  detached: "tone-idle",
};

function lcTone(lc: string) {
  return LIFECYCLE_TONE[lc] ?? "tone-idle";
}
</script>

<template>
  <div class="stack-lg">
    <div class="row-between">
      <h2 class="section-title">Volumes</h2>
      <button v-if="!archived" class="primary small" @click="showCreate = !showCreate">
        <AppIcon :name="showCreate ? 'x' : 'plus'" :size="14" />
        {{ showCreate ? "ยกเลิก" : "สร้าง volume" }}
      </button>
    </div>

    <!-- Create form -->
    <div v-if="showCreate" class="inset stack">
      <label>
        <span>ชื่อ</span>
        <input v-model="createForm.displayName" placeholder="my-data" />
      </label>
      <label>
        <span>Mount path</span>
        <input v-model="createForm.mountPath" class="mono" placeholder="/app/data" />
      </label>
      <label>
        <span>Access mode</span>
        <select v-model="createForm.accessMode">
          <option value="shared-safe">shared-safe (แนะนำ)</option>
          <option value="single-writer">single-writer (downtime ระหว่าง deploy)</option>
        </select>
      </label>
      <div class="check-row">
        <input v-model="createForm.readOnly" type="checkbox" id="vol-ro" />
        <label for="vol-ro">Read-only mount</label>
      </div>
      <p v-if="createError" class="alert alert-bad small">
        <AppIcon name="alert" :size="13" />
        <span>{{ createError }}</span>
      </p>
      <button
        class="primary small"
        style="align-self: flex-start"
        :disabled="creating || !createForm.displayName.trim() || !createForm.mountPath.trim()"
        @click="createVolume"
      >
        <span v-if="creating" class="spinner" />
        {{ creating ? "กำลังสร้าง…" : "สร้าง" }}
      </button>
    </div>

    <div v-if="loading" class="stack">
      <span class="skeleton" style="height: 90px" />
      <span class="skeleton" style="height: 90px" />
    </div>
    <p v-else-if="loadError" class="alert alert-bad">
      <AppIcon name="alert" :size="15" />
      <span>{{ loadError }}</span>
    </p>
    <div v-else-if="volumes.length === 0" class="empty">
      <span class="empty-icon"><AppIcon name="database" :size="20" /></span>
      <span class="empty-title">ยังไม่มี volume</span>
    </div>

    <!-- Volume list -->
    <ul v-else class="vol-list">
      <li v-for="v in volumes" :key="v.id" class="inset vol-item">
        <div class="vol-header">
          <strong>{{ v.displayName }}</strong>
          <span class="badge" :class="lcTone(v.lifecycle)">{{ v.lifecycle }}</span>
          <span v-if="v.readOnly" class="badge">read-only</span>
        </div>

        <dl class="kv">
          <dt>Mount path</dt>
          <dd><code>{{ v.mountPath }}</code></dd>
          <dt>Docker name</dt>
          <dd><code class="muted small">{{ v.dockerName }}</code></dd>
          <dt>Access mode</dt>
          <dd>{{ v.accessMode }}</dd>
          <dt>Last attached</dt>
          <dd :title="fullDateTime(v.lastAttachedAt)">{{ timeAgo(v.lastAttachedAt) }}</dd>
        </dl>

        <!-- lastError จาก reconciler แม่นกว่าข้อความ hardcode — fallback เมื่อยังไม่มีค่า (record เก่า) -->
        <p v-if="v.lifecycle === 'error'" class="alert alert-bad small">
          <AppIcon name="alert" :size="13" />
          <span>{{ v.lastError ?? "Docker volume หายไป — อาจถูกลบด้วยมือ ดู runbook สำหรับ recovery" }}</span>
        </p>
        <p v-if="v.lifecycle === 'deletion_pending'" class="alert alert-warn small">
          <AppIcon name="clock" :size="13" />
          <span>{{ v.lastError ?? "รอ worker ลบ Docker volume จริง…" }}</span>
        </p>

        <p v-if="detachError[v.id]" class="alert alert-bad small">
          <AppIcon name="alert" :size="13" />
          <span>{{ detachError[v.id] }}</span>
        </p>

        <div v-if="!archived" class="vol-actions">
          <button
            v-if="v.lifecycle === 'active'"
            class="secondary small"
            :disabled="detachingId === v.id"
            @click="detach(v.id)"
          >
            <span v-if="detachingId === v.id" class="spinner" />
            {{ detachingId === v.id ? "กำลัง detach…" : "Detach" }}
          </button>

          <button
            v-if="v.lifecycle !== 'deletion_pending'"
            class="danger small"
            :disabled="v.lifecycle === 'active'"
            :title="v.lifecycle === 'active' ? 'ต้อง detach ก่อนลบ' : ''"
            @click="openDelete(v)"
          >
            <AppIcon name="trash" :size="13" />
            ลบ
          </button>
        </div>

        <!-- Typed delete confirm -->
        <div v-if="confirmDeleteId === v.id" class="confirm-delete">
          <p class="warn-text small">
            พิมพ์ชื่อ volume <strong>{{ v.displayName }}</strong> เพื่อยืนยันการลบ
          </p>
          <p class="muted small">ข้อมูลใน volume จะหายถาวร — ไม่สามารถกู้คืนได้</p>
          <input
            v-model="confirmInput"
            placeholder="ชื่อ volume"
            @keydown.enter="deleteVolume"
          />
          <p v-if="deleteError" class="alert alert-bad small">
            <AppIcon name="alert" :size="13" />
            <span>{{ deleteError }}</span>
          </p>
          <div class="confirm-actions">
            <button class="danger small" :disabled="!canDelete || deleting" @click="deleteVolume">
              <span v-if="deleting" class="spinner" />
              {{ deleting ? "กำลังลบ…" : "ยืนยันลบ" }}
            </button>
            <button
              class="secondary small"
              @click="confirmDeleteId = null; confirmInput = ''"
            >
              ยกเลิก
            </button>
          </div>
        </div>
      </li>
    </ul>

    <p class="muted small note">
      <AppIcon name="info" :size="13" />
      volume จะถูก mount ทุกครั้งที่ deploy — redeploy เพื่อให้การเปลี่ยนแปลงมีผล
    </p>
  </div>
</template>

<style scoped>
.vol-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}
.vol-item {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}
.vol-header {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
}

.vol-actions {
  display: flex;
  gap: var(--s-2);
}

.confirm-delete {
  border-top: 1px solid var(--border-subtle);
  padding-top: var(--s-3);
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.confirm-actions {
  display: flex;
  gap: var(--s-2);
}

.note {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
</style>
