<script setup lang="ts">
/**
 * Managed service backups — ประวัติ + ตั้งเวลา + restore (Phase 16)
 *
 * dump/restore จริงทำโดย worker (ADR-0002) — ที่นี่แค่สั่ง job (enqueue ผ่าน control-api),
 * แสดงประวัติที่ worker เขียนไว้, ดาวน์โหลด/ลบไฟล์ที่มีอยู่แล้ว
 *
 * โครง dialog ก็อปจาก ServiceLogsDialog.vue (backdrop/Teleport เดียวกัน) แต่ไม่มี SSE —
 * ประวัติ backup อัปเดตช้ากว่า log มาก poll ธรรมดาพอ (ถี่ขึ้นเฉพาะตอนมีงาน running ค้างอยู่)
 */
const props = defineProps<{
  serviceId: string;
  serviceName: string;
  backupEnabled: boolean;
  backupIntervalHours: number | null;
  backupRetentionCount: number;
}>();
const emit = defineEmits<{ close: []; updated: [] }>();

interface BackupItem {
  id: string;
  serviceId: string;
  trigger: "manual" | "scheduled";
  status: "running" | "succeeded" | "failed";
  fileName: string | null;
  sizeBytes: number | null;
  failureMessage: string | null;
  startedAt: number;
  finishedAt: number | null;
  createdAt: number;
}

const api = useApi();
const { t } = useI18n();

// ── ประวัติ backup ──
const backups = ref<BackupItem[]>([]);
const loading = ref(true);
const loadError = ref("");

async function load() {
  loadError.value = "";
  try {
    const { data, error } = await api.api.v1.services({ id: props.serviceId }).backups.get();
    if (error) {
      loadError.value = t("databases.backups.error.load");
      return;
    }
    backups.value = (data?.items ?? []) as BackupItem[];
  } catch {
    loadError.value = t("common.apiUnreachable");
  } finally {
    loading.value = false;
  }
}

await load();

// poll ถี่ขึ้นระหว่างมีงาน running ค้างอยู่ — worker เขียนแถวนี้ตรง ไม่มี SSE ให้ subscribe
const anyRunning = computed(() => backups.value.some((b) => b.status === "running"));
onMounted(() => {
  let timer: ReturnType<typeof setInterval> | null = null;
  const schedule = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => load(), anyRunning.value ? 4_000 : 20_000);
  };
  watch(anyRunning, schedule, { immediate: true });
  onUnmounted(() => timer && clearInterval(timer));
});

// ── ตั้งเวลา + retention ──
// ต้องตรงกับ SERVICE_BACKUP_SETTINGS.allowedIntervalHours (internal/shared/src/constants.ts)
const INTERVAL_HOURS = [6, 12, 24, 168];
const intervalOptions = computed(() =>
  INTERVAL_HOURS.map((value) => ({ value, label: t(`databases.interval.h${value}`) })),
);

const settings = reactive({
  enabled: props.backupEnabled,
  intervalHours: props.backupIntervalHours ?? 24,
  retentionCount: props.backupRetentionCount,
});
const savingSettings = ref(false);
const settingsError = ref("");
const settingsSaved = ref(false);

async function saveSettings() {
  savingSettings.value = true;
  settingsError.value = "";
  settingsSaved.value = false;
  try {
    const { error } = await api.api.v1.services({ id: props.serviceId }).patch({
      backupEnabled: settings.enabled,
      backupIntervalHours: settings.intervalHours,
      backupRetentionCount: settings.retentionCount,
    });
    if (error) {
      settingsError.value = apiErrorMessage(error, "databases.backups.error.saveSettings");
      return;
    }
    settingsSaved.value = true;
    setTimeout(() => (settingsSaved.value = false), 2000);
    emit("updated");
  } catch {
    settingsError.value = t("common.apiUnreachable");
  } finally {
    savingSettings.value = false;
  }
}

// ── สั่ง backup ทันที ──
const triggering = ref(false);
const triggerError = ref("");

async function triggerBackup() {
  triggering.value = true;
  triggerError.value = "";
  try {
    const { error } = await api.api.v1.services({ id: props.serviceId }).backups.post();
    if (error) {
      triggerError.value = apiErrorMessage(error, "databases.backups.error.trigger");
      return;
    }
    await load();
    emit("updated");
  } finally {
    triggering.value = false;
  }
}

// ── ลบ ──
const confirmDelete = ref<BackupItem | null>(null);
const deleting = ref(false);

async function doDelete() {
  const target = confirmDelete.value;
  if (!target) return;
  deleting.value = true;
  try {
    await api.api.v1.services({ id: props.serviceId }).backups({ backupId: target.id }).delete();
    confirmDelete.value = null;
    await load();
  } finally {
    deleting.value = false;
  }
}

// ── restore — เขียนทับข้อมูลปัจจุบันทั้งหมด ต้องพิมพ์ชื่อ service ยืนยัน ──
const confirmRestore = ref<BackupItem | null>(null);
const restoring = ref(false);

async function doRestore() {
  const target = confirmRestore.value;
  if (!target) return;
  restoring.value = true;
  try {
    await api.api.v1
      .services({ id: props.serviceId })
      .backups({ backupId: target.id })
      .restore.post();
    confirmRestore.value = null;
    emit("updated");
  } finally {
    restoring.value = false;
  }
}

function downloadUrl(backupId: string): string {
  return `/api/v1/services/${props.serviceId}/backups/${backupId}/download`;
}

// เรียกจาก template — อ่าน locale ตอน render จึงเปลี่ยนตามภาษาเอง
function statusLabel(status: BackupItem["status"]): string {
  return t(`databases.backups.status.${status}`);
}
// "running" ใช้โทนเดียวกับ deploy ที่กำลังทำงาน (ฟ้า) ไม่ใช่ .status-running (เขียว) ที่หมายถึง
// service กำลังรันอยู่ปกติ — สื่อความหมายคนละอย่างกันแม้ชื่อ status จะพ้องกัน
const STATUS_CLASS: Record<BackupItem["status"], string> = {
  running: "status-starting",
  succeeded: "status-succeeded",
  failed: "status-failed",
};
function triggerLabel(trigger: BackupItem["trigger"]): string {
  return t(`databases.backups.trigger.${trigger}`);
}

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString(localeTag(), { dateStyle: "short", timeStyle: "short" });
}
</script>

<template>
  <Teleport to="body">
    <div class="backdrop" @click.self="emit('close')">
      <div class="dialog card" role="dialog" aria-modal="true">
        <div class="row-between">
          <h2 class="section-title truncate">Backups — {{ serviceName }}</h2>
          <button class="ghost icon small" :aria-label="$t('common.close')" @click="emit('close')">
            <AppIcon name="x" :size="15" />
          </button>
        </div>

        <div class="dialog-body">
          <!-- ── ตั้งเวลา + retention ── -->
          <section class="inset stack">
            <div class="check-row">
              <input id="bk-enabled" v-model="settings.enabled" type="checkbox" />
              <label for="bk-enabled">{{ $t("databases.backups.auto") }}</label>
            </div>

            <div v-if="settings.enabled" class="settings-grid">
              <label>
                <span>{{ $t("databases.backups.frequency") }}</span>
                <select v-model.number="settings.intervalHours">
                  <option v-for="opt in intervalOptions" :key="opt.value" :value="opt.value">
                    {{ opt.label }}
                  </option>
                </select>
              </label>
              <label>
                <span>{{ $t("databases.backups.retention") }}</span>
                <input v-model.number="settings.retentionCount" type="number" min="1" max="30" />
              </label>
            </div>

            <p v-if="settingsError" class="alert alert-bad small">
              <AppIcon name="alert" :size="13" />
              <span>{{ settingsError }}</span>
            </p>

            <div class="actions-end">
              <span v-if="settingsSaved" class="muted small">{{ $t("common.saved") }}</span>
              <button class="secondary small" :disabled="savingSettings" @click="saveSettings">
                <span v-if="savingSettings" class="spinner" />
                {{ savingSettings ? $t("common.saving") : $t("databases.backups.saveSettings") }}
              </button>
            </div>
          </section>

          <!-- ── ประวัติ ── -->
          <div class="row-between">
            <h3 class="section-title small">{{ $t("databases.backups.history") }}</h3>
            <button class="primary small" :disabled="triggering" @click="triggerBackup">
              <span v-if="triggering" class="spinner" />
              <AppIcon v-else name="database" :size="13" />
              {{
                triggering ? $t("databases.backups.triggering") : $t("databases.backups.backupNow")
              }}
            </button>
          </div>

          <p v-if="triggerError" class="alert alert-bad small">
            <AppIcon name="alert" :size="13" />
            <span>{{ triggerError }}</span>
          </p>

          <div v-if="loading" class="stack-sm">
            <span class="skeleton" style="height: 60px" />
            <span class="skeleton" style="height: 60px" />
          </div>
          <p v-else-if="loadError" class="alert alert-bad small">
            <AppIcon name="alert" :size="13" />
            <span>{{ loadError }}</span>
          </p>
          <div v-else-if="backups.length === 0" class="empty">
            <span class="empty-icon"><AppIcon name="database" :size="18" /></span>
            <span class="empty-title">{{ $t("databases.backups.empty") }}</span>
          </div>

          <ul v-else class="bk-list">
            <li v-for="b in backups" :key="b.id" class="inset bk-item">
              <div class="bk-header">
                <span class="status" :class="STATUS_CLASS[b.status]">
                  {{ statusLabel(b.status) }}
                </span>
                <span class="badge tiny">{{ triggerLabel(b.trigger) }}</span>
                <span class="spacer" />
                <span class="muted tiny">{{ fmtTime(b.createdAt) }}</span>
              </div>

              <p v-if="b.status === 'failed' && b.failureMessage" class="alert alert-bad tiny">
                <AppIcon name="alert" :size="13" />
                <span>{{ b.failureMessage }}</span>
              </p>

              <div v-if="b.status === 'succeeded'" class="bk-actions">
                <span class="muted tiny">{{ formatBytes(b.sizeBytes) }}</span>
                <span class="spacer" />
                <a class="secondary small" :href="downloadUrl(b.id)" download>
                  <AppIcon name="download" :size="13" />
                  {{ $t("databases.backups.download") }}
                </a>
                <button class="secondary small" @click="confirmRestore = b">
                  <AppIcon name="rotate" :size="13" />
                  Restore
                </button>
                <button class="danger small" @click="confirmDelete = b">
                  <AppIcon name="trash" :size="13" />
                  {{ $t("common.delete") }}
                </button>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </Teleport>

  <ConfirmDialog
    :open="!!confirmDelete"
    :title="$t('databases.backups.confirmDelete.title')"
    :message="$t('databases.backups.confirmDelete.message')"
    :confirm-label="$t('databases.deletePermanently')"
    :busy="deleting"
    @cancel="confirmDelete = null"
    @confirm="doDelete"
  />

  <ConfirmDialog
    :open="!!confirmRestore"
    title="Restore database"
    :message="$t('databases.backups.confirmRestore.message')"
    :confirm-label="$t('databases.backups.confirmRestore.confirm')"
    :require-typed="serviceName"
    :busy="restoring"
    @cancel="confirmRestore = null"
    @confirm="doRestore"
  />
</template>

<style scoped>
.dialog {
  width: min(680px, 92vw);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}
.dialog-body {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  overflow-y: auto;
}
.section-title.small {
  font-size: var(--t-sm);
}

.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--s-3);
}
.settings-grid label {
  margin: 0;
}

.bk-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.bk-item {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-3);
}
.bk-header {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
}
.bk-actions {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
}
.bk-actions a.secondary {
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

@media (max-width: 560px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }
}
</style>
