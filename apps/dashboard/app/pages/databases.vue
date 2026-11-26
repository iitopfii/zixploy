<script setup lang="ts">
/**
 * Managed databases — Phase 10 M4
 *
 * เลือก template จาก catalog แล้วกดสร้าง — ไม่ต้องเขียน Dockerfile หรือ compose เอง
 * control-api สร้าง record + งาน แล้ว worker เป็นคน provision จริง (ADR-0002)
 */
const api = useApi();
const { t } = useI18n();

const { data: catalog } = await useAsyncData(
  "service-catalog",
  async () => (await api.api.v1["service-catalog"].get()).data?.items ?? [],
  { server: false },
);

const {
  data: services,
  pending,
  error,
  refresh,
} = await useAsyncData(
  "services",
  async () => {
    const { data, error: apiError } = await api.api.v1.services.get();
    if (apiError) throw new Error(t("databases.error.load"));
    return data?.items ?? [];
  },
  { server: false },
);

/**
 * poll ถี่ขึ้นระหว่างมีงานค้าง — provision ใช้เวลาหลายสิบวินาที ผู้ใช้ต้องเห็นความคืบหน้า
 * ไม่มีงานค้างแล้วก็ยังโหลดซ้ำเป็นระยะเผื่อ container ตายเอง
 */
const anyBusy = computed(() => (services.value ?? []).some((s) => s.busy));
onMounted(() => {
  let timer: ReturnType<typeof setInterval> | null = null;
  const schedule = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => refresh(), anyBusy.value ? 3_000 : 20_000);
  };
  watch(anyBusy, schedule, { immediate: true });
  onUnmounted(() => timer && clearInterval(timer));
});

// ── สร้างใหม่ ──
const creating = ref(false);
const picked = ref<string | null>(null);
const form = reactive({ name: "", version: "", exposePort: false, exposedPort: 5432 });
const createError = ref("");
const saving = ref(false);

const pickedTemplate = computed(() => catalog.value?.find((c) => c.type === picked.value) ?? null);

function choose(type: string) {
  const tpl = catalog.value?.find((c) => c.type === type);
  if (!tpl) return;
  picked.value = type;
  form.name = suggestName(type);
  form.version = tpl.defaultVersion;
  form.exposedPort = tpl.internalPort;
  form.exposePort = false;
  createError.value = "";
}

/** ชื่อที่ไม่ซ้ำกับที่มีอยู่ — ต่อเลขท้ายถ้าชนกัน */
function suggestName(type: string): string {
  const existing = new Set((services.value ?? []).map((s) => s.name));
  if (!existing.has(type)) return type;
  for (let i = 2; i < 100; i++) {
    if (!existing.has(`${type}-${i}`)) return `${type}-${i}`;
  }
  return type;
}

function resetCreate() {
  creating.value = false;
  picked.value = null;
  createError.value = "";
}

async function submitCreate() {
  if (!picked.value || !form.name.trim()) return;
  saving.value = true;
  createError.value = "";
  try {
    const { error: apiError } = await api.api.v1.services.post({
      name: form.name.trim(),
      // biome-ignore lint/suspicious/noExplicitAny: type มาจาก catalog runtime ซึ่งตรงกับ union ฝั่ง API
      type: picked.value as any,
      version: form.version,
      exposedPort: form.exposePort ? form.exposedPort : null,
    });
    if (apiError) {
      createError.value = apiErrorMessage(apiError, "databases.error.create");
      return;
    }
    resetCreate();
    await refresh();
  } finally {
    saving.value = false;
  }
}

// ── การกระทำกับ service ที่มีอยู่ ──
const acting = ref<string | null>(null);

async function act(id: string, action: "start" | "stop" | "restart") {
  acting.value = id;
  try {
    const svc = api.api.v1.services({ id });
    if (action === "start") await svc.start.post();
    else if (action === "stop") await svc.stop.post();
    else await svc.restart.post();
    await refresh();
  } finally {
    acting.value = null;
  }
}

const confirmDelete = ref<{ id: string; name: string } | null>(null);
const deleting = ref(false);

async function doDelete() {
  const target = confirmDelete.value;
  if (!target) return;
  deleting.value = true;
  try {
    await api.api.v1.services({ id: target.id }).delete();
    confirmDelete.value = null;
    await refresh();
  } finally {
    deleting.value = false;
  }
}

// ── credentials ──
const credsFor = ref<string | null>(null);
const creds = ref<Record<string, unknown> | null>(null);
const credsLoading = ref(false);

async function showCredentials(id: string) {
  credsFor.value = id;
  creds.value = null;
  credsLoading.value = true;
  try {
    const { data } = await api.api.v1.services({ id }).credentials.get();
    creds.value = (data ?? null) as Record<string, unknown> | null;
  } finally {
    credsLoading.value = false;
  }
}

/** credentialMode ของ template — MinIO ไม่มีชื่อ database, ClamAV ไม่มี auth เลย */
function credentialModeOf(type: string | undefined): string {
  return catalog.value?.find((c) => c.type === type)?.credentialMode ?? "full";
}

const credsMode = computed(() =>
  credentialModeOf(services.value?.find((s) => s.id === credsFor.value)?.type),
);

const credRows = computed(() => {
  const c = creds.value;
  if (!c) return [];
  const rows = [
    { label: t("databases.creds.host"), value: String(c.internalHost) },
    { label: "Port", value: String(c.internalPort) },
  ];
  if (credsMode.value === "user-password") {
    rows.push(
      { label: "Access key", value: String(c.username) },
      { label: "Secret key", value: String(c.password) },
    );
  } else if (credsMode.value === "full") {
    rows.push(
      { label: "Username", value: String(c.username) },
      { label: "Password", value: String(c.password) },
      { label: "Database", value: String(c.databaseName) },
    );
  }
  return rows;
});

// ── logs ──
const logsFor = ref<{ id: string; name: string } | null>(null);

// ── terminal ──
const terminalFor = ref<{ id: string; name: string } | null>(null);

// ── backups ──
const backupsFor = ref<string | null>(null);
const backupsForService = computed(
  () => services.value?.find((s) => s.id === backupsFor.value) ?? null,
);

const copied = ref("");
async function copy(text: string, label: string) {
  await navigator.clipboard.writeText(text);
  copied.value = label;
  setTimeout(() => (copied.value = ""), 1800);
}

// เรียกจาก template — อ่าน locale ตอน render จึงเปลี่ยนตามภาษาเอง · status ที่ไม่รู้จักแสดงค่าดิบ
function statusLabel(status: string): string {
  const key = `databases.status.${status}`;
  return hasMessage(key) ? t(key) : status;
}

const CATEGORY_LABEL: Record<string, string> = {
  sql: "SQL",
  nosql: "NoSQL",
  cache: "Cache",
  storage: "Storage",
  security: "Security",
};

// ต้องตรงกับ SERVICE_BACKUP_SETTINGS.allowedIntervalHours (internal/shared/src/constants.ts)
function backupIntervalLabel(hours: number | null | undefined): string {
  const key = `databases.interval.h${hours ?? 0}`;
  return hasMessage(key) ? t(key) : t("databases.interval.other", { n: hours });
}
</script>

<template>
  <div class="stack-lg">
    <header class="page-head">
      <div>
        <h1>Databases</h1>
        <p class="muted small">{{ $t("databases.subtitle") }}</p>
      </div>
      <div class="actions">
        <button
          class="secondary icon"
          :title="$t('databases.reload')"
          :aria-label="$t('databases.reload')"
          @click="refresh()"
        >
          <AppIcon name="refresh" :size="15" />
        </button>
        <button v-if="!creating" class="primary" @click="creating = true">
          <AppIcon name="plus" :size="15" />
          {{ $t("databases.add") }}
        </button>
      </div>
    </header>

    <!-- ── ตัวเลือก template ── -->
    <section v-if="creating" class="card stack">
      <div class="row-between">
        <h2 class="section-title">{{ $t("databases.pickType") }}</h2>
        <button class="ghost small" @click="resetCreate">
          <AppIcon name="x" :size="14" />
          {{ $t("common.cancel") }}
        </button>
      </div>

      <ul class="template-grid">
        <li v-for="tpl in catalog ?? []" :key="tpl.type">
          <button
            class="template"
            :class="{ selected: picked === tpl.type }"
            @click="choose(tpl.type)"
          >
            <span class="tpl-icon" :class="`cat-${tpl.category}`">
              <AppIcon name="database" :size="18" />
            </span>
            <span class="tpl-body">
              <span class="tpl-name">
                {{ tpl.displayName }}
                <span class="badge tiny">{{ CATEGORY_LABEL[tpl.category] }}</span>
              </span>
              <span class="tpl-tagline muted tiny">{{ tpl.tagline }}</span>
            </span>
            <AppIcon v-if="picked === tpl.type" name="check" :size="16" class="tpl-check" />
          </button>
        </li>
      </ul>

      <!-- ── ตั้งค่า ── -->
      <form v-if="pickedTemplate" class="config inset" @submit.prevent="submitCreate">
        <div class="config-grid">
          <label>
            <span>{{ $t("databases.form.name") }}</span>
            <input v-model="form.name" maxlength="60" :disabled="saving" />
            <span v-if="pickedTemplate.credentialMode === 'full'" class="field-hint">
              {{ $t("databases.form.nameHintFull") }}
            </span>
            <span v-else-if="pickedTemplate.credentialMode === 'user-password'" class="field-hint">
              {{ $t("databases.form.nameHintAccessKey") }}
            </span>
          </label>

          <label>
            <span>{{ $t("databases.form.version") }}</span>
            <select v-model="form.version" :disabled="saving">
              <option v-for="v in pickedTemplate.versions" :key="v" :value="v">{{ v }}</option>
            </select>
            <span class="field-hint">{{ $t("databases.form.versionHint") }}</span>
          </label>
        </div>

        <div class="expose">
          <div class="check-row">
            <input id="expose" v-model="form.exposePort" type="checkbox" :disabled="saving" />
            <label for="expose">{{ $t("databases.form.expose") }}</label>
          </div>
          <p class="field-hint">
            {{ $t("databases.form.exposeHint") }}
          </p>

          <label v-if="form.exposePort" class="port-field">
            <span>{{ $t("databases.form.serverPort") }}</span>
            <input v-model.number="form.exposedPort" type="number" min="1024" max="60000" />
          </label>

          <p
            v-if="form.exposePort && pickedTemplate.credentialMode === 'none'"
            class="alert alert-bad"
          >
            <AppIcon name="alert" :size="15" />
            <span>
              {{ $t("databases.form.exposeNoAuthWarning", { name: pickedTemplate.displayName }) }}
            </span>
          </p>
          <p v-else-if="form.exposePort" class="alert alert-warn">
            <AppIcon name="alert" :size="15" />
            <span>
              {{ $t("databases.form.exposeWarning") }}
            </span>
          </p>
          <p v-if="pickedTemplate.defaultMemoryMb > 512" class="field-hint">
            {{ $t("databases.form.memoryHint", { mb: pickedTemplate.defaultMemoryMb }) }}
          </p>
        </div>

        <p v-if="createError" class="alert alert-bad">
          <AppIcon name="alert" :size="15" />
          <span>{{ createError }}</span>
        </p>

        <div class="actions-end">
          <button type="button" class="secondary" :disabled="saving" @click="resetCreate">
            {{ $t("common.cancel") }}
          </button>
          <button class="primary" type="submit" :disabled="saving || !form.name.trim()">
            <span v-if="saving" class="spinner" />
            {{
              saving
                ? $t("common.creating")
                : $t("databases.form.submit", { name: pickedTemplate.displayName })
            }}
          </button>
        </div>
      </form>
    </section>

    <!-- ── รายการ ── -->
    <div v-if="pending && !services" class="grid">
      <div v-for="n in 2" :key="n" class="card skeleton-card">
        <span class="skeleton" style="width: 40%; height: 1.1em" />
        <span class="skeleton" style="width: 65%; height: 0.85em" />
      </div>
    </div>

    <div v-else-if="error" class="card">
      <div class="empty">
        <span class="empty-icon"><AppIcon name="alert" :size="20" /></span>
        <span class="empty-title">{{ $t("databases.error.load") }}</span>
        <button class="secondary" @click="refresh()">{{ $t("common.retry") }}</button>
      </div>
    </div>

    <div v-else-if="!services?.length && !creating" class="card">
      <div class="empty">
        <span class="empty-icon"><AppIcon name="database" :size="20" /></span>
        <span class="empty-title">{{ $t("databases.empty.title") }}</span>
        <p class="small">{{ $t("databases.empty.hint") }}</p>
        <button class="primary" @click="creating = true">
          <AppIcon name="plus" :size="15" />
          {{ $t("databases.add") }}
        </button>
      </div>
    </div>

    <ul v-else-if="services?.length" class="grid">
      <li v-for="svc in services" :key="svc.id">
        <div class="card service">
          <div class="svc-head">
            <div class="svc-title">
              <span class="tpl-icon small" :class="`type-${svc.type}`">
                <AppIcon name="database" :size="15" />
              </span>
              <div class="stack-sm">
                <strong class="truncate">{{ svc.name }}</strong>
                <span class="muted tiny">{{ svc.image }}</span>
              </div>
            </div>
            <span class="status" :class="`status-${svc.status}`">
              {{ statusLabel(svc.status) }}
            </span>
          </div>

          <p v-if="svc.failureMessage" class="alert alert-bad tiny">
            <AppIcon name="alert" :size="14" />
            <span>{{ svc.failureMessage }}</span>
          </p>

          <dl class="kv compact">
            <dt>{{ $t("databases.card.internal") }}</dt>
            <dd>
              <code class="tiny">{{ svc.internalHost }}:{{ svc.internalPort }}</code>
              <button
                class="ghost tiny copy-btn"
                :aria-label="$t('databases.card.copyHost')"
                :title="$t('common.copy')"
                @click="copy(`${svc.internalHost}:${svc.internalPort}`, `host-${svc.id}`)"
              >
                <AppIcon :name="copied === `host-${svc.id}` ? 'check' : 'copy'" :size="12" />
              </button>
            </dd>
            <dt>{{ $t("databases.card.externalPort") }}</dt>
            <dd>
              <code v-if="svc.exposedPort" class="tiny">{{ svc.exposedPort }}</code>
              <span v-else class="muted tiny">{{ $t("databases.card.portClosed") }}</span>
            </dd>
            <dt>Backup</dt>
            <dd>
              <span v-if="svc.backupEnabled" class="tiny">
                {{ backupIntervalLabel(svc.backupIntervalHours) }}
              </span>
              <span v-else class="muted tiny">{{ $t("databases.card.noSchedule") }}</span>
              <span v-if="svc.lastBackupAt" class="muted tiny">
                {{ $t("databases.card.lastBackup", { time: timeAgo(svc.lastBackupAt) }) }}
              </span>
            </dd>
          </dl>

          <div class="svc-actions">
            <button
              class="secondary small"
              :disabled="svc.busy"
              @click="showCredentials(svc.id)"
            >
              <AppIcon name="key" :size="13" />
              {{ $t("databases.action.credentials") }}
            </button>

            <button
              class="secondary small"
              :disabled="svc.busy"
              @click="logsFor = { id: svc.id, name: svc.name }"
            >
              <AppIcon name="terminal" :size="13" />
              Logs
            </button>

            <button class="secondary small" @click="backupsFor = svc.id">
              <AppIcon name="download" :size="13" />
              Backups
            </button>

            <button
              v-if="svc.supportsTerminal"
              class="secondary small"
              :disabled="svc.busy"
              @click="terminalFor = { id: svc.id, name: svc.name }"
            >
              <AppIcon name="terminal" :size="13" />
              Terminal
            </button>

            <button
              v-if="svc.status === 'running'"
              class="secondary small"
              :disabled="svc.busy || acting === svc.id"
              @click="act(svc.id, 'stop')"
            >
              <AppIcon name="stop" :size="13" />
              {{ $t("databases.action.stop") }}
            </button>
            <button
              v-else
              class="secondary small"
              :disabled="svc.busy || acting === svc.id || svc.status === 'deleting'"
              @click="act(svc.id, 'start')"
            >
              <AppIcon name="play" :size="13" />
              {{ $t("databases.action.start") }}
            </button>

            <button
              class="secondary small"
              :disabled="svc.busy || acting === svc.id"
              @click="act(svc.id, 'restart')"
            >
              <AppIcon name="rotate" :size="13" />
              {{ $t("databases.action.restart") }}
            </button>

            <span class="spacer" />

            <button
              class="danger small"
              :disabled="svc.busy"
              @click="confirmDelete = { id: svc.id, name: svc.name }"
            >
              <AppIcon name="trash" :size="13" />
              {{ $t("common.delete") }}
            </button>
          </div>

          <p v-if="svc.busy" class="busy-note tiny muted">
            <span class="spinner" />
            {{ $t("common.working") }}
          </p>
        </div>
      </li>
    </ul>

    <!-- ── credentials modal ── -->
    <Teleport to="body">
      <div v-if="credsFor" class="backdrop" @click.self="credsFor = null">
        <div class="dialog card" role="dialog" aria-modal="true">
          <div class="row-between">
            <h2 class="section-title">{{ $t("databases.action.credentials") }}</h2>
            <button
              class="ghost icon small"
              :aria-label="$t('common.close')"
              @click="credsFor = null"
            >
              <AppIcon name="x" :size="15" />
            </button>
          </div>

          <p v-if="credsLoading" class="muted small">{{ $t("common.loading") }}</p>

          <template v-else-if="creds">
            <p v-if="credsMode !== 'none'" class="alert alert-warn tiny">
              <AppIcon name="lock" :size="14" />
              <span>{{ $t("databases.creds.secretWarning") }}</span>
            </p>

            <div class="cred-list">
              <div v-for="row in credRows" :key="row.label" class="cred-row">
                <span class="cred-label muted tiny">{{ row.label }}</span>
                <code class="cred-value">{{ row.value }}</code>
                <button class="ghost tiny" @click="copy(row.value, row.label)">
                  {{ copied === row.label ? $t("common.copied") : $t("common.copy") }}
                </button>
              </div>
            </div>

            <div class="uri-block">
              <span class="eyebrow">{{ $t("databases.creds.internalUri") }}</span>
              <div class="uri-row">
                <code class="uri">{{ creds.internalUri }}</code>
                <button class="secondary small" @click="copy(String(creds.internalUri), 'uri')">
                  <AppIcon name="copy" :size="13" />
                  {{ copied === "uri" ? $t("common.copied") : $t("common.copy") }}
                </button>
              </div>
            </div>

            <div v-if="creds.externalUri" class="uri-block">
              <span class="eyebrow">{{ $t("databases.creds.externalUri") }}</span>
              <div class="uri-row">
                <code class="uri">{{ creds.externalUri }}</code>
                <button class="secondary small" @click="copy(String(creds.externalUri), 'ext')">
                  <AppIcon name="copy" :size="13" />
                  {{ copied === "ext" ? $t("common.copied") : $t("common.copy") }}
                </button>
              </div>
              <i18n-t scope="global" keypath="databases.creds.serverIpHint" tag="p" class="field-hint">
                <template #placeholder><code>&lt;SERVER_IP&gt;</code></template>
              </i18n-t>
            </div>
          </template>
        </div>
      </div>
    </Teleport>

    <ConfirmDialog
      :open="!!confirmDelete"
      :title="$t('databases.confirmDelete.title')"
      :message="$t('databases.confirmDelete.message')"
      :confirm-label="$t('databases.deletePermanently')"
      :require-typed="confirmDelete?.name ?? ''"
      :busy="deleting"
      @cancel="confirmDelete = null"
      @confirm="doDelete"
    />

    <ServiceLogsDialog
      v-if="logsFor"
      :service-id="logsFor.id"
      :service-name="logsFor.name"
      @close="logsFor = null"
    />

    <TerminalDialog
      v-if="terminalFor"
      :service-id="terminalFor.id"
      :service-name="terminalFor.name"
      @close="terminalFor = null"
    />

    <ServiceBackupsDialog
      v-if="backupsFor && backupsForService"
      :service-id="backupsFor"
      :service-name="backupsForService.name"
      :backup-enabled="backupsForService.backupEnabled"
      :backup-interval-hours="backupsForService.backupIntervalHours"
      :backup-retention-count="backupsForService.backupRetentionCount"
      @close="backupsFor = null"
      @updated="refresh"
    />
  </div>
</template>

<style scoped>
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s-4);
  flex-wrap: wrap;
}
.page-head p {
  margin-top: 0.15rem;
}

/* ── template picker ── */
.template-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--s-2);
}
.template {
  width: 100%;
  height: auto;
  display: flex;
  align-items: flex-start;
  gap: var(--s-3);
  padding: var(--s-3);
  text-align: left;
  background: var(--bg-subtle);
  border-color: var(--border-subtle);
}
.template:hover:not(:disabled) {
  border-color: var(--border-strong);
}
.template.selected {
  border-color: var(--accent);
  background: var(--accent-tint);
}
.tpl-icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: var(--r-sm);
  background: var(--surface-3);
  color: var(--text-secondary);
}
.tpl-icon.small {
  width: 26px;
  height: 26px;
}
.cat-sql,
.type-postgres,
.type-mysql,
.type-mariadb,
.type-libsql,
.type-pgvector {
  background: var(--info-tint);
  color: var(--info);
}
.cat-storage,
.type-minio {
  background: var(--accent-tint);
  color: var(--accent);
}
.cat-security,
.type-clamav {
  background: var(--warn-tint);
  color: var(--warn);
}
.cat-cache,
.type-redis {
  background: var(--bad-tint);
  color: var(--bad);
}
.cat-nosql,
.type-mongodb {
  background: var(--ok-tint);
  color: var(--ok);
}
.tpl-body {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
  flex: 1;
}
.tpl-name {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  font-weight: 600;
  font-size: var(--t-sm);
}
.tpl-tagline {
  line-height: 1.45;
  white-space: normal;
}
.tpl-check {
  color: var(--accent);
  margin-top: 2px;
}

/* ── config form ── */
.config {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
}
.config-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: var(--s-4);
}
.config label {
  margin: 0;
}
.expose {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.expose .check-row {
  margin: 0;
}
.port-field {
  max-width: 200px;
}

/* ── service list ── */
.grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: var(--s-3);
}
.service {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding: var(--s-4);
  height: 100%;
}
.svc-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s-3);
}
.svc-title {
  display: flex;
  gap: var(--s-3);
  min-width: 0;
}
.kv.compact {
  grid-template-columns: minmax(90px, max-content) 1fr;
  gap: var(--s-2) var(--s-4);
  font-size: var(--t-sm);
}
.copy-btn {
  width: 22px;
  height: 22px;
  padding: 0;
  margin-left: 0.35rem;
  display: inline-grid;
  place-items: center;
  vertical-align: middle;
}
.svc-actions {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
  margin-top: auto;
  padding-top: var(--s-2);
  border-top: 1px solid var(--border-subtle);
}
.busy-note {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.skeleton-card {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding: var(--s-4);
}

/* ── credentials dialog ── */
/* .backdrop มาจาก main.css (global) — ห้ามนิยามซ้ำที่นี่ ดู comment ในไฟล์นั้น */
.dialog {
  width: 100%;
  max-width: 560px;
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  box-shadow: var(--shadow-lg), var(--shadow-inset);
}
.cred-list {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.cred-row {
  display: grid;
  grid-template-columns: minmax(140px, auto) 1fr auto;
  align-items: center;
  gap: var(--s-3);
}
.cred-value {
  overflow-x: auto;
  white-space: nowrap;
  font-size: var(--t-xs);
}
.uri-block {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.uri-row {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}
.uri {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  padding: var(--s-2);
  background: var(--bg-subtle);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-sm);
  font-size: var(--t-xs);
}

@media (max-width: 640px) {
  .config-grid {
    grid-template-columns: 1fr;
  }
  .cred-row {
    grid-template-columns: 1fr auto;
  }
  .cred-label {
    grid-column: 1 / -1;
  }
}
</style>
