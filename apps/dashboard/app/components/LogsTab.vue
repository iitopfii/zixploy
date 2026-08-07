<script setup lang="ts">
/**
 * Logs Tab — Phase 6
 *
 * สองโหมด:
 * 1. Build logs — เลือก deployment แล้วดู log ของ build/deploy นั้น
 *    GET /api/v1/deployments/:id/logs (paginated)
 *    GET /api/v1/deployments/:id/logs/stream (SSE live สำหรับ in-flight)
 * 2. Runtime logs — log จาก container ที่รันอยู่ (live SSE)
 *    GET /api/v1/projects/:id/runtime-logs
 *    GET /api/v1/projects/:id/runtime-logs/stream (SSE live)
 */
const props = defineProps<{ projectId: string }>();

const api = useApi();

// ---------------------------------------------------------------------------
// Mode toggle
// ---------------------------------------------------------------------------

const mode = ref<"build" | "runtime">("build");

// ---------------------------------------------------------------------------
// Deployments list (for build log selector)
// ---------------------------------------------------------------------------

interface DeploymentSummary {
  id: string;
  status: string;
  trigger: string;
  commitSha: string;
  queuedAt: number;
}

const deploymentList = ref<DeploymentSummary[]>([]);
const loadingDeps = ref(true);

async function fetchDeploymentList() {
  const { data } = await api.api.v1.projects({ id: props.projectId }).deployments.get({
    query: { limit: "30" },
  });
  deploymentList.value = (data?.items ?? []) as DeploymentSummary[];
  loadingDeps.value = false;
}

await fetchDeploymentList();

const selectedDepId = ref(deploymentList.value[0]?.id ?? "");

// ---------------------------------------------------------------------------
// Build logs
// ---------------------------------------------------------------------------

interface LogLine {
  seq: number;
  stream: "stdout" | "stderr";
  line: string;
  createdAt: number;
}

const buildLogs = ref<LogLine[]>([]);
const loadingBuildLogs = ref(false);
const buildLogError = ref("");
let sseAbort: AbortController | null = null;

const IN_FLIGHT = ["queued", "cloning", "building", "starting", "health_checking", "activating"];

const selectedDep = computed(() => deploymentList.value.find((d) => d.id === selectedDepId.value));
const isLive = computed(() => !!selectedDep.value && IN_FLIGHT.includes(selectedDep.value.status));

async function loadBuildLogs() {
  if (!selectedDepId.value) return;
  stopSse();
  buildLogs.value = [];
  loadingBuildLogs.value = true;
  buildLogError.value = "";

  try {
    const { data, error } = await api.api.v1.deployments({ id: selectedDepId.value }).logs.get({
      query: {},
    });
    if (error) {
      buildLogError.value = "โหลด logs ไม่ได้";
      return;
    }
    buildLogs.value = (data?.logs ?? []) as LogLine[];
    if (isLive.value) startBuildSse();
  } catch {
    buildLogError.value = "ติดต่อ API ไม่ได้";
  } finally {
    loadingBuildLogs.value = false;
  }
}

function startBuildSse() {
  stopSse();
  sseAbort = new AbortController();
  const lastSeq = buildLogs.value[buildLogs.value.length - 1]?.seq ?? 0;
  const url = `/api/v1/deployments/${selectedDepId.value}/logs/stream${lastSeq ? `?afterSeq=${lastSeq}` : ""}`;
  const es = new EventSource(url);
  es.onmessage = (ev) => {
    if (ev.data === ":heartbeat") return;
    try {
      const entry = JSON.parse(ev.data) as LogLine;
      buildLogs.value.push(entry);
      scrollToBottom();
    } catch {
      /* ignore */
    }
  };
  es.onerror = () => {
    es.close();
  };
  sseAbort.signal.addEventListener("abort", () => es.close());
}

function stopSse() {
  sseAbort?.abort();
  sseAbort = null;
}

watch(selectedDepId, loadBuildLogs, { immediate: true });
onUnmounted(stopSse);

// ---------------------------------------------------------------------------
// Runtime logs
// ---------------------------------------------------------------------------

interface RuntimeLine {
  seq: number;
  stream: "stdout" | "stderr";
  line: string;
  loggedAt: number;
}

const runtimeLogs = ref<RuntimeLine[]>([]);
const loadingRuntime = ref(false);
const runtimeError = ref("");
let runtimeSse: AbortController | null = null;

async function loadRuntimeLogs() {
  stopRuntimeSse();
  runtimeLogs.value = [];
  loadingRuntime.value = true;
  runtimeError.value = "";

  try {
    const { data, error } = await api.api.v1.projects({ id: props.projectId })["runtime-logs"].get({
      query: {},
    });
    if (error) {
      runtimeError.value = "โหลด runtime logs ไม่ได้";
      return;
    }
    runtimeLogs.value = (data?.logs ?? []) as RuntimeLine[];
    startRuntimeSse();
  } catch {
    runtimeError.value = "ติดต่อ API ไม่ได้";
  } finally {
    loadingRuntime.value = false;
  }
}

function startRuntimeSse() {
  stopRuntimeSse();
  runtimeSse = new AbortController();
  const lastSeq = runtimeLogs.value[runtimeLogs.value.length - 1]?.seq ?? 0;
  const url = `/api/v1/projects/${props.projectId}/runtime-logs/stream${lastSeq ? `?afterSeq=${lastSeq}` : ""}`;
  const es = new EventSource(url);
  es.onmessage = (ev) => {
    if (ev.data === ":heartbeat") return;
    try {
      const entry = JSON.parse(ev.data) as RuntimeLine;
      runtimeLogs.value.push(entry);
      if (runtimeLogs.value.length > 2000) runtimeLogs.value.splice(0, 500);
      scrollToBottom();
    } catch {
      /* ignore */
    }
  };
  es.onerror = () => {
    es.close();
  };
  runtimeSse.signal.addEventListener("abort", () => es.close());
}

function stopRuntimeSse() {
  runtimeSse?.abort();
  runtimeSse = null;
}

watch(mode, (m) => {
  if (m === "runtime") loadRuntimeLogs();
  else {
    stopRuntimeSse();
    loadBuildLogs();
  }
});
onUnmounted(stopRuntimeSse);

// ---------------------------------------------------------------------------
// Auto-scroll
// ---------------------------------------------------------------------------

const logBox = ref<HTMLElement | null>(null);
const autoScroll = ref(true);

function scrollToBottom() {
  if (!autoScroll.value || !logBox.value) return;
  nextTick(() => {
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
  });
}

function onScroll() {
  if (!logBox.value) return;
  const { scrollTop, scrollHeight, clientHeight } = logBox.value;
  autoScroll.value = scrollHeight - scrollTop - clientHeight < 60;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString("th-TH", { timeStyle: "short" });
}
</script>

<template>
  <div class="stack">
    <!-- Mode toggle -->
    <div class="tabs mode-tabs">
      <button class="tab" :class="{ active: mode === 'build' }" @click="mode = 'build'">
        <AppIcon name="box" :size="14" />
        Build logs
      </button>
      <button class="tab" :class="{ active: mode === 'runtime' }" @click="mode = 'runtime'">
        <AppIcon name="terminal" :size="14" />
        Runtime logs
      </button>
    </div>

    <!-- Build logs -->
    <template v-if="mode === 'build'">
      <div class="toolbar">
        <select v-model="selectedDepId" class="dep-select" :disabled="loadingDeps">
          <option v-if="loadingDeps" value="">กำลังโหลด…</option>
          <option v-else-if="deploymentList.length === 0" value="">ยังไม่มี deployment</option>
          <option v-for="d in deploymentList" :key="d.id" :value="d.id">
            {{ shortSha(d.commitSha) }} — {{ d.status }} — {{ fmtTime(d.queuedAt) }}
          </option>
        </select>
        <span v-if="isLive" class="status status-running is-live">LIVE</span>
        <button
          class="ghost icon small"
          :disabled="loadingBuildLogs"
          title="รีเฟรช"
          aria-label="รีเฟรช"
          @click="loadBuildLogs"
        >
          <AppIcon name="refresh" :size="14" />
        </button>
      </div>

      <p v-if="buildLogError" class="alert alert-bad small">
        <AppIcon name="alert" :size="14" />
        <span>{{ buildLogError }}</span>
      </p>

      <div ref="logBox" class="log-box" @scroll="onScroll">
        <div v-if="loadingBuildLogs" class="stack-sm">
          <span class="skeleton" style="height: 14px; width: 90%" />
          <span class="skeleton" style="height: 14px; width: 75%" />
          <span class="skeleton" style="height: 14px; width: 82%" />
        </div>
        <p v-else-if="buildLogs.length === 0" class="muted small center">ยังไม่มี log</p>
        <div
          v-for="l in buildLogs"
          :key="l.seq"
          class="log-line"
          :class="l.stream === 'stderr' ? 'log-err' : ''"
        >
          <span class="log-time">{{ fmtTime(l.createdAt) }}</span>
          <span class="log-text">{{ l.line }}</span>
        </div>
      </div>
    </template>

    <!-- Runtime logs -->
    <template v-else>
      <div class="toolbar">
        <span class="status status-running is-live">LIVE</span>
        <button class="secondary small" @click="loadRuntimeLogs">
          <AppIcon name="refresh" :size="13" />
          รีเชื่อม
        </button>
        <button class="ghost small" @click="runtimeLogs = []">ล้าง</button>
        <span class="spacer" />
        <label class="autoscroll-label">
          <input v-model="autoScroll" type="checkbox" />
          Auto-scroll
        </label>
      </div>

      <p v-if="runtimeError" class="alert alert-bad small">
        <AppIcon name="alert" :size="14" />
        <span>{{ runtimeError }}</span>
      </p>

      <div ref="logBox" class="log-box" @scroll="onScroll">
        <div v-if="loadingRuntime" class="stack-sm">
          <span class="skeleton" style="height: 14px; width: 90%" />
          <span class="skeleton" style="height: 14px; width: 75%" />
        </div>
        <p v-else-if="runtimeLogs.length === 0" class="muted small center">รอ log จาก container…</p>
        <div
          v-for="l in runtimeLogs"
          :key="l.seq"
          class="log-line"
          :class="l.stream === 'stderr' ? 'log-err' : ''"
        >
          <span class="log-time">{{ fmtTime(l.loggedAt) }}</span>
          <span class="log-text">{{ l.line }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.mode-tabs {
  align-self: flex-start;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  flex-wrap: wrap;
}

.dep-select {
  flex: 1;
  min-width: 160px;
}

/* .log-box, .log-line, .log-time, .log-text มาจาก main.css ทั้งหมด */
.log-box {
  height: 420px;
}
.log-err .log-text {
  color: var(--bad);
}
.center {
  text-align: center;
  padding: var(--s-4);
}

.autoscroll-label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: var(--t-sm);
  color: var(--text-muted);
  margin: 0;
}
</style>
