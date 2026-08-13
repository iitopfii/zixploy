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

// ── ประวัติ backup ──
const backups = ref<BackupItem[]>([]);
const loading = ref(true);
const loadError = ref("");

async function load() {
  loadError.value = "";
  try {
    const { data, error } = await api.api.v1.services({ id: props.serviceId }).backups.get();
    if (error) {
      loadError.value = "โหลดประวัติ backup ไม่สำเร็จ";
      return;
    }
    backups.value = (data?.items ?? []) as BackupItem[];
  } catch {
    loadError.value = "ติดต่อ API ไม่ได้";
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
const INTERVAL_OPTIONS = [
  { value: 6, label: "ทุก 6 ชั่วโมง" },
  { value: 12, label: "ทุก 12 ชั่วโมง" },
  { value: 24, label: "ทุกวัน" },
  { value: 168, label: "ทุกสัปดาห์" },
];

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
      settingsError.value =
        (error.value as { error?: { message?: string } } | null)?.error?.message ??
        "บันทึกการตั้งค่าไม่สำเร็จ";
      return;
    }
    settingsSaved.value = true;
    setTimeout(() => (settingsSaved.value = false), 2000);
    emit("updated");
  } catch {
    settingsError.value = "ติดต่อ API ไม่ได้";
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
      triggerError.value =
        (error.value as { error?: { message?: string } } | null)?.error?.message ??
        "สั่ง backup ไม่สำเร็จ";
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

const STATUS_LABEL: Record<BackupItem["status"], string> = {
  running: "กำลังสำรอง…",
  succeeded: "สำเร็จ",
  failed: "ล้มเหลว",
};
// "running" ใช้โทนเดียวกับ deploy ที่กำลังทำงาน (ฟ้า) ไม่ใช่ .status-running (เขียว) ที่หมายถึง
// service กำลังรันอยู่ปกติ — สื่อความหมายคนละอย่างกันแม้ชื่อ status จะพ้องกัน
const STATUS_CLASS: Record<BackupItem["status"], string> = {
  running: "status-starting",
  succeeded: "status-succeeded",
  failed: "status-failed",
};
const TRIGGER_LABEL: Record<BackupItem["trigger"], string> = {
  manual: "สั่งเอง",
  scheduled: "ตามตารางเวลา",
};

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" });
}
</script>

<template>
  <Teleport to="body">
    <div class="backdrop" @click.self="emit('close')">
      <div class="dialog card" role="dialog" aria-modal="true">
        <div class="row-between">
          <h2 class="section-title truncate">Backups — {{ serviceName }}</h2>
          <button class="ghost icon small" aria-label="ปิด" @click="emit('close')">
            <AppIcon name="x" :size="15" />
          </button>
        </div>

        <div class="dialog-body">
          <!-- ── ตั้งเวลา + retention ── -->
          <section class="inset stack">
            <div class="check-row">
              <input id="bk-enabled" v-model="settings.enabled" type="checkbox" />
              <label for="bk-enabled">สำรองข้อมูลอัตโนมัติตามตารางเวลา</label>
            </div>

            <div v-if="settings.enabled" class="settings-grid">
              <label>
                <span>ความถี่</span>
                <select v-model.number="settings.intervalHours">
                  <option v-for="opt in INTERVAL_OPTIONS" :key="opt.value" :value="opt.value">
                    {{ opt.label }}
                  </option>
                </select>
              </label>
              <label>
                <span>เก็บไว้ล่าสุดกี่ชุด</span>
                <input v-model.number="settings.retentionCount" type="number" min="1" max="30" />
              </label>
            </div>

            <p v-if="settingsError" class="alert alert-bad small">
              <AppIcon name="alert" :size="13" />
              <span>{{ settingsError }}</span>
            </p>

            <div class="actions-end">
              <span v-if="settingsSaved" class="muted small">บันทึกแล้ว</span>
              <button class="secondary small" :disabled="savingSettings" @click="saveSettings">
                <span v-if="savingSettings" class="spinner" />
                {{ savingSettings ? "กำลังบันทึก…" : "บันทึกการตั้งค่า" }}
              </button>
            </div>
          </section>

          <!-- ── ประวัติ ── -->
          <div class="row-between">
            <h3 class="section-title small">ประวัติ backup</h3>
            <button class="primary small" :disabled="triggering" @click="triggerBackup">
              <span v-if="triggering" class="spinner" />
              <AppIcon v-else name="database" :size="13" />
              {{ triggering ? "กำลังสั่ง…" : "สำรองข้อมูลตอนนี้" }}
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
            <span class="empty-title">ยังไม่มี backup</span>
          </div>

          <ul v-else class="bk-list">
            <li v-for="b in backups" :key="b.id" class="inset bk-item">
              <div class="bk-header">
                <span class="status" :class="STATUS_CLASS[b.status]">
                  {{ STATUS_LABEL[b.status] }}
                </span>
                <span class="badge tiny">{{ TRIGGER_LABEL[b.trigger] }}</span>
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
                  ดาวน์โหลด
                </a>
                <button class="secondary small" @click="confirmRestore = b">
                  <AppIcon name="rotate" :size="13" />
                  Restore
                </button>
                <button class="danger small" @click="confirmDelete = b">
                  <AppIcon name="trash" :size="13" />
                  ลบ
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
    title="ลบ backup"
    message="ไฟล์ backup ชุดนี้จะถูกลบถาวร กู้คืนไม่ได้"
    confirm-label="ลบถาวร"
    :busy="deleting"
    @cancel="confirmDelete = null"
    @confirm="doDelete"
  />

  <ConfirmDialog
    :open="!!confirmRestore"
    title="Restore database"
    message="ข้อมูลปัจจุบันทั้งหมดใน database นี้จะถูกเขียนทับด้วยข้อมูลจาก backup ชุดนี้ทันที — ย้อนกลับไม่ได้ (แนะนำให้สำรองข้อมูลปัจจุบันไว้ก่อนถ้ายังต้องการ)"
    confirm-label="เขียนทับและ Restore"
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
