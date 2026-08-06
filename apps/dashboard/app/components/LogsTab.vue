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

const selectedDep = computed(() =>
  deploymentList.value.find((d) => d.id === selectedDepId.value),
);
const isLive = computed(() =>
  !!selectedDep.value && IN_FLIGHT.includes(selectedDep.value.status),
);

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
    if (error) { buildLogError.value = "โหลด logs ไม่ได้"; return; }
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
    } catch { /* ignore */ }
  };
  es.onerror = () => { es.close(); };
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
    if (error) { runtimeError.value = "โหลด runtime logs ไม่ได้"; return; }
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
    } catch { /* ignore */ }
  };
  es.onerror = () => { es.close(); };
  runtimeSse.signal.addEventListener("abort", () => es.close());
}

function stopRuntimeSse() {
  runtimeSse?.abort();
  runtimeSse = null;
}

watch(mode, (m) => {
  if (m === "runtime") loadRuntimeLogs();
  else { stopRuntimeSse(); loadBuildLogs(); }
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

function shortSha(sha: string) { return sha.slice(0, 7); }
function fmtTime(ms: number) { return new Date(ms).toLocaleString("th-TH", { timeStyle: "short" }); }
</script>

<template>
  <div class="logs-tab">
    <!-- Mode toggle -->
    <div class="mode-row">
      <button :class="['mode-btn', { active: mode === 'build' }]" @click="mode = 'build'">Build logs</button>
      <button :class="['mode-btn', { active: mode === 'runtime' }]" @click="mode = 'runtime'">Runtime logs</button>
    </div>

    <!-- Build logs -->
    <template v-if="mode === 'build'">
      <div class="dep-selector">
        <select v-model="selectedDepId" class="dep-select" :disabled="loadingDeps">
          <option v-if="loadingDeps" value="">กำลังโหลด…</option>
          <option v-else-if="deploymentList.length === 0" value="">ยังไม่มี deployment</option>
          <option v-for="d in deploymentList" :key="d.id" :value="d.id">
            {{ shortSha(d.commitSha) }} — {{ d.status }} — {{ fmtTime(d.queuedAt) }}
          </option>
        </select>
        <span v-if="isLive" class="live-badge">● LIVE</span>
        <button class="secondary small" :disabled="loadingBuildLogs" @click="loadBuildLogs">↺</button>
      </div>

      <p v-if="buildLogError" class="error-text small">{{ buildLogError }}</p>
      <p v-if="loadingBuildLogs" class="muted small">กำลังโหลด…</p>

      <div ref="logBox" class="log-box" @scroll="onScroll">
        <p v-if="buildLogs.length === 0 && !loadingBuildLogs" class="muted small center">ยังไม่มี log</p>
        <div v-for="l in buildLogs" :key="l.seq" class="log-line" :class="l.stream === 'stderr' ? 'log-err' : ''">
          <span class="log-time">{{ fmtTime(l.createdAt) }}</span>
          <span class="log-text">{{ l.line }}</span>
        </div>
      </div>
    </template>

    <!-- Runtime logs -->
    <template v-else>
      <div class="runtime-header">
        <span class="live-badge">● LIVE</span>
        <button class="secondary small" @click="loadRuntimeLogs">↺ รีเชื่อม</button>
        <button class="secondary small" @click="runtimeLogs = []">ล้าง</button>
        <label class="autoscroll-label">
          <input type="checkbox" v-model="autoScroll" />
          Auto-scroll
        </label>
      </div>

      <p v-if="runtimeError" class="error-text small">{{ runtimeError }}</p>
      <p v-if="loadingRuntime" class="muted small">กำลังโหลด…</p>

      <div ref="logBox" class="log-box" @scroll="onScroll">
        <p v-if="runtimeLogs.length === 0 && !loadingRuntime" class="muted small center">
          รอ log จาก container…
        </p>
        <div v-for="l in runtimeLogs" :key="l.seq" class="log-line" :class="l.stream === 'stderr' ? 'log-err' : ''">
          <span class="log-time">{{ fmtTime(l.loggedAt) }}</span>
          <span class="log-text">{{ l.line }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.logs-tab { display: flex; flex-direction: column; gap: 0.75rem; }

.mode-row { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--border); }
.mode-btn {
  padding: 0.35rem 0.75rem;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--muted);
  font-size: 0.875rem;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.mode-btn.active { color: var(--fg); border-bottom-color: var(--accent); }

.dep-selector { display: flex; align-items: center; gap: 0.5rem; }
.dep-select {
  flex: 1;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--fg);
  font-size: 0.875rem;
}

.runtime-header { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }

.live-badge {
  font-size: 0.75rem;
  color: #16a34a;
  font-weight: 700;
  animation: pulse 1.5s infinite;
}
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

.log-box {
  background: #0d1117;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.75rem;
  height: 400px;
  overflow-y: auto;
  font-family: ui-monospace, monospace;
  font-size: 0.8rem;
  line-height: 1.5;
}
.log-line { display: flex; gap: 0.75rem; }
.log-time { color: #6e7681; flex-shrink: 0; }
.log-text { color: #e6edf3; white-space: pre-wrap; word-break: break-all; }
.log-err .log-text { color: #ff7b72; }
.center { text-align: center; }

.autoscroll-label { display: flex; align-items: center; gap: 0.25rem; font-size: 0.8rem; color: var(--muted); }
</style>
