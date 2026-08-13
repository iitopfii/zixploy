<script setup lang="ts">
/**
 * Service (database) log viewer — Phase 15
 *
 * โครง SSE เดียวกับ runtime mode ของ LogsTab.vue (project) ทุกประการ รวมถึง performance
 * safeguard ที่เคยแก้บั๊กหน้า Logs ค้างทั้งเบราว์เซอร์ (batch ต่อเฟรมผ่าน requestAnimationFrame,
 * ตัด DOM ที่ MAX_RENDERED_LINES, scroll ครั้งเดียวต่อเฟรม) — ไม่ได้ import ตรง ๆ เพราะ LogsTab
 * ผูกกับ /projects/:id/... path และมี build-log mode ปนอยู่ ซึ่ง service ไม่มีแนวคิดนี้เลย
 * แยกไฟล์นี้ต่างหากอ่านง่ายกว่าเพิ่ม branch ที่สามใน component เดิม
 */
const props = defineProps<{ serviceId: string; serviceName: string }>();
const emit = defineEmits<{ close: [] }>();

interface LogLine {
  seq: number;
  stream: "stdout" | "stderr";
  line: string;
  loggedAt: number;
}

const api = useApi();
const logs = ref<LogLine[]>([]);
const loading = ref(true);
const error = ref("");
const autoScroll = ref(true);
let sse: AbortController | null = null;

const MAX_RENDERED_LINES = 800;
const TRIM_CHUNK = 200;

async function load() {
  stopSse();
  logs.value = [];
  loading.value = true;
  error.value = "";

  try {
    const { data, error: apiError } = await api.api.v1
      .services({ id: props.serviceId })
      .logs.get({ query: {} });
    if (apiError) {
      error.value = "โหลด log ไม่ได้";
      return;
    }
    logs.value = (data?.logs ?? []) as LogLine[];
    startSse();
  } catch {
    error.value = "ติดต่อ API ไม่ได้";
  } finally {
    loading.value = false;
  }
}

function startSse() {
  stopSse();
  sse = new AbortController();

  // ส่ง seq ล่าสุดที่มีอยู่ ไม่งั้น server จะยิง ring buffer ทั้งก้อนกลับมาซ้ำ
  const lastSeq = logs.value[logs.value.length - 1]?.seq ?? 0;
  const url = `/api/v1/services/${props.serviceId}/logs/stream${lastSeq ? `?afterSeq=${lastSeq}` : ""}`;
  const es = new EventSource(url);

  let pending: LogLine[] = [];
  let flushQueued = false;

  function flush() {
    flushQueued = false;
    if (pending.length === 0) return;

    const batch = pending;
    pending = [];
    logs.value.push(...batch);

    if (logs.value.length > MAX_RENDERED_LINES) {
      logs.value.splice(0, logs.value.length - MAX_RENDERED_LINES + TRIM_CHUNK);
    }
    scrollToBottom();
  }

  es.onmessage = (ev) => {
    try {
      pending.push(JSON.parse(ev.data) as LogLine);
    } catch {
      return;
    }
    if (!flushQueued) {
      flushQueued = true;
      requestAnimationFrame(flush);
    }
  };

  es.onerror = () => es.close();
  sse.signal.addEventListener("abort", () => es.close());
}

function stopSse() {
  sse?.abort();
  sse = null;
}

await load();
onUnmounted(stopSse);

const logBox = ref<HTMLElement | null>(null);
let scrollQueued = false;

function scrollToBottom() {
  if (!autoScroll.value || scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    const el = logBox.value;
    if (el && autoScroll.value) el.scrollTop = el.scrollHeight;
  });
}

function onScroll() {
  if (!logBox.value) return;
  const { scrollTop, scrollHeight, clientHeight } = logBox.value;
  autoScroll.value = scrollHeight - scrollTop - clientHeight < 60;
}

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString("th-TH", { timeStyle: "short" });
}
</script>

<template>
  <Teleport to="body">
    <div class="backdrop" @click.self="emit('close')">
      <div class="dialog card" role="dialog" aria-modal="true">
        <div class="row-between">
          <h2 class="section-title truncate">Logs — {{ serviceName }}</h2>
          <button class="ghost icon small" aria-label="ปิด" @click="emit('close')">
            <AppIcon name="x" :size="15" />
          </button>
        </div>

        <div class="toolbar">
          <span class="status status-running is-live">LIVE</span>
          <button class="secondary small" @click="load">
            <AppIcon name="refresh" :size="13" />
            รีเชื่อม
          </button>
          <button class="ghost small" @click="logs = []">ล้าง</button>
          <span class="spacer" />
          <label class="autoscroll-label">
            <input v-model="autoScroll" type="checkbox" />
            Auto-scroll
          </label>
        </div>

        <p v-if="error" class="alert alert-bad small">
          <AppIcon name="alert" :size="14" />
          <span>{{ error }}</span>
        </p>

        <div ref="logBox" class="log-box" @scroll="onScroll">
          <div v-if="loading" class="stack-sm">
            <span class="skeleton" style="height: 14px; width: 90%" />
            <span class="skeleton" style="height: 14px; width: 75%" />
          </div>
          <p v-else-if="logs.length === 0" class="muted small center">รอ log จาก container…</p>
          <div
            v-for="l in logs"
            :key="l.seq"
            class="log-line"
            :class="l.stream === 'stderr' ? 'log-err' : ''"
          >
            <span class="log-time">{{ fmtTime(l.loggedAt) }}</span>
            <span class="log-text">{{ l.line }}</span>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dialog {
  width: min(720px, 92vw);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  flex-wrap: wrap;
}

/* .log-box, .log-line, .log-time, .log-text มาจาก main.css */
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
