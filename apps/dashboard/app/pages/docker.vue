<script setup lang="ts">
/**
 * Docker inventory — รายชื่อ container/image ทั้งเครื่อง
 *
 * ข้อมูลมาจาก /system/docker ซึ่งอ่าน snapshot ที่ deploy-worker กวาดไว้ทุก ~30 วิ
 * (control-api ไม่แตะ Docker เอง) — หน้านี้อ่านอย่างเดียว ไม่มีปุ่มสั่ง start/stop/ลบ
 */
const api = useApi();
const { t } = useI18n();

const { data, pending, error, refresh } = await useAsyncData(
  "docker-inventory",
  async () => {
    const { data: body, error: apiError } = await api.api.v1.system.docker.get();
    if (apiError) throw new Error(t("docker.error.load"));
    return body;
  },
  { server: false },
);

// รีเฟรชอัตโนมัติเท่าความถี่ที่ worker กวาดจริง
onMounted(() => {
  const timer = setInterval(() => refresh(), 30_000);
  onUnmounted(() => clearInterval(timer));
});

const tab = ref<"containers" | "images">("containers");
const filter = ref("");

const containers = computed(() => {
  const list = data.value?.containers ?? [];
  const q = filter.value.trim().toLowerCase();
  if (!q) return list;
  return list.filter((c) => c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q));
});

const images = computed(() => {
  const list = data.value?.images ?? [];
  const q = filter.value.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (i) => i.repository.toLowerCase().includes(q) || i.tag.toLowerCase().includes(q),
  );
});

const runningCount = computed(
  () => (data.value?.containers ?? []).filter((c) => c.state === "running").length,
);

// ---------------------------------------------------------------------------
// นำเข้า container ที่ไม่ได้สร้างผ่าน Zixploy ให้เป็น project ที่จัดการได้
//
// control-api แตะ Docker ไม่ได้ (worker เป็นคนอ่าน config) หน้านี้จึงสั่งแล้ว poll สถานะ
// จนกว่าจะได้ config มาแสดงให้ตรวจ — ค่าของ env ไม่เคยถูกส่งมาที่นี่ มีแค่ชื่อ key
// ---------------------------------------------------------------------------

interface ImportPreview {
  id: string;
  containerName: string;
  status: string;
  image: string | null;
  command: string | null;
  restartPolicy: string | null;
  envKeys: string[];
  ports: Array<{ hostPort: number; containerPort: number }>;
  mounts: Array<{ source: string; target: string; type: string; readOnly: boolean }>;
  projectId: string | null;
  failureMessage: string | null;
}

const importing = ref<string | null>(null);
const preview = ref<ImportPreview | null>(null);
const importError = ref("");
const projectName = ref("");
const confirming = ref(false);

async function startImport(containerId: string, containerName: string) {
  importing.value = containerId;
  importError.value = "";
  preview.value = null;
  try {
    const { data, error } = await api.api.v1.system.docker
      .containers({ containerId })
      .import.post({});
    if (error) {
      importError.value = apiErrorMessage(error, "docker.error.importStart");
      return;
    }
    projectName.value = containerName.replace(/^\//, "");
    await pollPreview(data.id);
  } catch {
    importError.value = t("common.apiUnreachable");
  } finally {
    importing.value = null;
  }
}

/** รอ worker อ่าน config (ปกติไม่กี่วินาที) — หยุดเมื่อได้ผลหรือพัง */
async function pollPreview(id: string) {
  for (let i = 0; i < 20; i++) {
    const { data, error } = await api.api.v1.system.docker.imports({ id }).get();
    if (error) {
      importError.value = apiErrorMessage(error, "docker.error.status");
      return;
    }
    if (data.status === "inspected" || data.status === "done") {
      preview.value = data as ImportPreview;
      return;
    }
    if (data.status === "failed") {
      importError.value = data.failureMessage ?? t("docker.error.inspect");
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  importError.value = t("docker.error.workerTimeout");
}

async function confirmImport() {
  if (!preview.value) return;
  confirming.value = true;
  importError.value = "";
  try {
    const { error } = await api.api.v1.system.docker
      .imports({ id: preview.value.id })
      .confirm.post({ projectName: projectName.value.trim() || undefined });
    if (error) {
      importError.value = apiErrorMessage(error, "docker.error.confirm");
      return;
    }
    // worker สร้าง project ให้ — รอจน done แล้วพาไปหน้า project
    for (let i = 0; i < 20; i++) {
      const { data } = await api.api.v1.system.docker.imports({ id: preview.value.id }).get();
      if (data?.status === "done" && data.projectId) {
        preview.value = null;
        await navigateTo(`/projects/${data.projectId}`);
        return;
      }
      if (data?.status === "failed") {
        importError.value = data.failureMessage ?? t("docker.error.import");
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    importError.value = t("docker.error.timeout");
  } finally {
    confirming.value = false;
  }
}

const STATE_TONE: Record<string, string> = {
  running: "tone-ok",
  exited: "tone-idle",
  created: "tone-idle",
  paused: "tone-warn",
  restarting: "tone-warn",
  dead: "tone-bad",
};
function stateTone(state: string) {
  return STATE_TONE[state] ?? "tone-idle";
}
</script>

<template>
  <div class="stack-lg">
    <header class="page-head">
      <div>
        <h1>Docker</h1>
        <p class="muted small">
          {{ $t("docker.subtitle") }}
        </p>
      </div>
      <div class="actions">
        <span v-if="data?.capturedAt" class="muted small" :title="fullDateTime(data.capturedAt)">
          {{ $t("docker.updated", { time: timeAgo(data.capturedAt) }) }}
        </span>
        <button
          class="secondary icon"
          :title="$t('docker.reload')"
          :aria-label="$t('docker.reload')"
          @click="refresh()"
        >
          <AppIcon name="rotate" :size="15" />
        </button>
      </div>
    </header>

    <!-- Loading (ครั้งแรก) -->
    <div v-if="pending && !data" class="stack">
      <span class="skeleton" style="height: 36px" />
      <span class="skeleton" style="height: 200px" />
    </div>

    <p v-else-if="error" class="alert alert-bad">
      <AppIcon name="alert" :size="15" />
      <span>{{ $t("docker.loadFailed") }}</span>
    </p>

    <!-- worker ยังไม่เคยกวาด (เพิ่งติดตั้ง/worker ไม่ทำงาน) -->
    <div v-else-if="!data?.capturedAt" class="card">
      <div class="empty">
        <span class="empty-icon"><AppIcon name="box" :size="20" /></span>
        <span class="empty-title">{{ $t("docker.empty.title") }}</span>
        <p class="small">
          {{ $t("docker.empty.hint") }}
        </p>
      </div>
    </div>

    <template v-else>
      <div class="row-between wrap">
        <nav class="tabs" :aria-label="$t('docker.tabsLabel')">
          <button
            class="tab"
            :class="{ active: tab === 'containers' }"
            @click="tab = 'containers'"
          >
            Containers
            <span class="count">{{ data.containers.length }}</span>
          </button>
          <button class="tab" :class="{ active: tab === 'images' }" @click="tab = 'images'">
            Images
            <span class="count">{{ data.images.length }}</span>
          </button>
        </nav>
        <input
          v-model="filter"
          class="filter-input"
          type="search"
          :placeholder="$t('docker.filterPlaceholder')"
        />
      </div>

      <!-- ── Containers ── -->
      <div v-if="tab === 'containers'" class="card stack">
        <p class="muted small">
          {{ $t("docker.runningSummary", { running: runningCount, total: data.containers.length }) }}
        </p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{{ $t("docker.col.name") }}</th>
                <th>{{ $t("docker.col.state") }}</th>
                <th>Image</th>
                <th>Ports</th>
                <th>{{ $t("docker.col.source") }}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in containers" :key="c.containerId">
                <td>
                  <div class="cell-main mono">{{ c.name }}</div>
                  <div class="cell-sub mono muted">{{ c.containerId }}</div>
                </td>
                <td>
                  <span class="badge" :class="stateTone(c.state)">{{ c.state }}</span>
                  <div class="cell-sub muted">{{ c.status }}</div>
                </td>
                <td class="mono small">{{ c.image }}</td>
                <td class="mono small">{{ c.ports ?? "—" }}</td>
                <td>
                  <span class="badge" :class="c.managed ? 'tone-ok' : 'tone-idle'">
                    {{ c.managed ? "Zixploy" : $t("docker.sourceOther") }}
                  </span>
                </td>
                <td>
                  <button
                    v-if="!c.managed"
                    class="secondary small"
                    :disabled="importing === c.containerId"
                    @click="startImport(c.containerId, c.name)"
                  >
                    <span v-if="importing === c.containerId" class="spinner" />
                    {{
                      importing === c.containerId
                        ? $t("docker.import.reading")
                        : $t("docker.import.action")
                    }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="containers.length === 0" class="muted small">
          {{ $t("docker.noContainers") }}
        </p>
      </div>

      <!-- ── Images ── -->
      <div v-else class="card stack">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Repository</th>
                <th>Tag</th>
                <th>Image ID</th>
                <th>{{ $t("docker.col.size") }}</th>
                <th>{{ $t("docker.col.created") }}</th>
                <th>{{ $t("docker.col.source") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="i in images" :key="`${i.imageId}-${i.repository}-${i.tag}`">
                <td class="mono">{{ i.repository }}</td>
                <td class="mono small">{{ i.tag }}</td>
                <td class="mono small muted">{{ i.imageId }}</td>
                <td class="small">{{ i.size ?? "—" }}</td>
                <td class="small muted">{{ i.createdSince ?? "—" }}</td>
                <td>
                  <span class="badge" :class="i.managed ? 'tone-ok' : 'tone-idle'">
                    {{ i.managed ? "Zixploy" : $t("docker.sourceOther") }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="images.length === 0" class="muted small">{{ $t("docker.noImages") }}</p>
      </div>

      <!-- error ของการนำเข้า (แสดงนอก dialog เพราะอาจพังตั้งแต่ยังไม่มี preview) -->
      <p v-if="importError && !preview" class="alert alert-bad small">
        <AppIcon name="alert" :size="13" />
        <span>{{ importError }}</span>
      </p>

      <!-- ตรวจ config ก่อนยืนยันนำเข้า -->
      <Teleport to="body">
        <div v-if="preview" class="backdrop" @click.self="preview = null">
          <div class="dialog card stack">
            <div>
              <h2 class="section-title">
                {{ $t("docker.import.title", { name: preview.containerName }) }}
              </h2>
              <i18n-t scope="global" keypath="docker.import.intro" tag="p" class="muted small">
                <template #emphasis>
                  <strong>{{ $t("docker.import.introEmphasis") }}</strong>
                </template>
              </i18n-t>
            </div>

            <label>
              <span>{{ $t("docker.import.projectName") }}</span>
              <input
                v-model="projectName"
                :placeholder="$t('docker.import.projectNamePlaceholder')"
              />
            </label>

            <dl class="kv">
              <dt>Image</dt>
              <dd><code class="small">{{ preview.image }}</code></dd>
              <template v-if="preview.command">
                <dt>Command</dt>
                <dd><code class="small">{{ preview.command }}</code></dd>
              </template>
              <dt>Restart</dt>
              <dd><code class="small">{{ preview.restartPolicy }}</code></dd>
              <template v-if="preview.ports.length">
                <dt>Ports</dt>
                <dd>
                  <code v-for="p in preview.ports" :key="p.containerPort" class="small port-chip">
                    {{ p.hostPort }} → {{ p.containerPort }}
                  </code>
                </dd>
              </template>
              <template v-if="preview.mounts.length">
                <dt>Volumes</dt>
                <dd class="stack-sm">
                  <code v-for="m in preview.mounts" :key="m.target" class="small">
                    {{ m.source }} → {{ m.target }}{{ m.readOnly ? " (ro)" : "" }}
                  </code>
                </dd>
              </template>
              <dt>Environment</dt>
              <dd>
                <template v-if="preview.envKeys.length">
                  <code v-for="k in preview.envKeys" :key="k" class="small port-chip">{{ k }}</code>
                  <p class="muted tiny">
                    {{ $t("docker.import.envNote") }}
                  </p>
                </template>
                <span v-else class="muted small">{{ $t("common.none") }}</span>
              </dd>
            </dl>

            <p class="muted small">
              <AppIcon name="info" :size="13" />
              {{ $t("docker.import.volumeNote") }}
            </p>

            <p v-if="importError" class="alert alert-bad small">
              <AppIcon name="alert" :size="13" />
              <span>{{ importError }}</span>
            </p>

            <div class="actions">
              <button class="primary" :disabled="confirming" @click="confirmImport">
                <span v-if="confirming" class="spinner" />
                {{ confirming ? $t("common.creating") : $t("docker.import.create") }}
              </button>
              <button class="secondary" :disabled="confirming" @click="preview = null">
                {{ $t("common.cancel") }}
              </button>
            </div>
          </div>
        </div>
      </Teleport>

      <p class="muted small note">
        <AppIcon name="info" :size="13" />
        {{ $t("docker.snapshotNote") }}
      </p>
    </template>
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
.actions {
  display: flex;
  align-items: center;
  gap: var(--s-3);
}

/* segmented tabs — โครงเดียวกับแท็บในหน้า project */
.tabs {
  display: flex;
  gap: 2px;
  padding: 3px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r);
}
.tab {
  height: 30px;
  padding: 0 var(--s-3);
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-muted);
  font-size: var(--t-sm);
  border-radius: var(--r-sm);
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.tab:hover:not(.active) {
  background: var(--surface-2);
  color: var(--text-secondary);
}
.tab.active {
  background: var(--surface-3);
  color: var(--text);
  font-weight: 550;
  box-shadow: var(--shadow-sm);
}
.count {
  font-size: var(--t-xs);
  padding: 0.05rem 0.4rem;
  background: var(--surface-2);
  border-radius: 999px;
  color: var(--text-muted);
}
.tab.active .count {
  background: var(--surface-1);
}

.filter-input {
  max-width: 240px;
}

/* ── ตาราง ── */
.table-wrap {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--t-sm);
}
th {
  text-align: left;
  padding: var(--s-2) var(--s-3);
  font-size: var(--t-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-subtle);
  white-space: nowrap;
}
td {
  padding: var(--s-2) var(--s-3);
  border-bottom: 1px solid var(--border-subtle);
  vertical-align: top;
}
tbody tr:last-child td {
  border-bottom: none;
}
tbody tr:hover {
  background: var(--surface-2);
}
.cell-main {
  font-weight: 550;
}
.cell-sub {
  font-size: var(--t-xs);
  margin-top: 0.15rem;
}

.note {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.dialog {
  max-width: 560px;
  width: 100%;
  max-height: 85vh;
  overflow-y: auto;
}
.port-chip {
  display: inline-block;
  margin: 0 var(--s-1) var(--s-1) 0;
}
</style>
