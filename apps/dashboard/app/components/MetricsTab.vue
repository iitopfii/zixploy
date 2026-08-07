<script setup lang="ts">
/**
 * Resource metrics ของ container ราย project — Phase 9 M4
 *
 * ต่างจากหน้า /monitoring ตรงที่ตัวนี้วัด container ของ project เดียว ไม่ใช่ทั้งเครื่อง
 * ข้อมูลมาจาก worker เช่นกัน (control-api อ่าน DB อย่างเดียว ตาม ADR-0002)
 */
const props = defineProps<{ projectId: string }>();

const api = useApi();

type Range = "1h" | "6h" | "24h";
const range = ref<Range>("1h");
const ranges: Array<{ key: Range; label: string }> = [
  { key: "1h", label: "1 ชม." },
  { key: "6h", label: "6 ชม." },
  { key: "24h", label: "24 ชม." },
];

const { data, pending, error, refresh } = await useAsyncData(
  () => `project-metrics-${props.projectId}-${range.value}`,
  async () => {
    const { data: body, error: apiError } = await api.api.v1
      .projects({ id: props.projectId })
      .metrics.get({ query: { range: range.value } });
    if (apiError) throw new Error("โหลด metrics ไม่สำเร็จ");
    return body;
  },
  { server: false, watch: [range, () => props.projectId] },
);

onMounted(() => {
  const timer = setInterval(() => refresh(), 15_000);
  onUnmounted(() => clearInterval(timer));
});

const latest = computed(() => data.value?.latest ?? null);
const points = computed(() => data.value?.points ?? []);
const gapMs = computed(() => (data.value?.range.sampleIntervalMs ?? 15_000) * 3);

const cpuSeries = computed(() => points.value.map((p) => ({ ts: p.ts, value: p.cpuPercent })));
const memSeries = computed(() => points.value.map((p) => ({ ts: p.ts, value: p.memUsedBytes })));

/** % ของ memory limit — คำนวณได้เฉพาะเมื่อตั้ง limit ไว้ (limit = 0 คือไม่จำกัด) */
const memPercent = computed(() => {
  const l = latest.value;
  if (!l || l.memLimitBytes <= 0) return null;
  return ratioPercent(l.memUsedBytes, l.memLimitBytes);
});

/** จุดสูงสุดของ CPU ในช่วงที่ดู — บอกได้ว่ามี spike ที่ค่าปัจจุบันไม่แสดง */
const cpuPeak = computed(() =>
  points.value.length ? Math.max(...points.value.map((p) => p.cpuPercent)) : null,
);

/** restart_count เพิ่มขึ้นในช่วงที่ดู = container ตายแล้วถูก restart จริง */
const restartsInRange = computed(() => {
  if (points.value.length < 2) return 0;
  const first = points.value[0];
  const last = points.value[points.value.length - 1];
  if (!first || !last) return 0;
  return Math.max(0, last.restartCount - first.restartCount);
});
</script>

<template>
  <div class="stack">
    <div class="row-between wrap">
      <h2 class="section-title">การใช้ทรัพยากร</h2>
      <div class="actions">
        <div class="range-switch" role="group" aria-label="ช่วงเวลา">
          <button
            v-for="r in ranges"
            :key="r.key"
            class="range-btn"
            :class="{ active: range === r.key }"
            @click="range = r.key"
          >
            {{ r.label }}
          </button>
        </div>
        <button class="secondary icon small" title="โหลดใหม่" aria-label="โหลดใหม่" @click="refresh()">
          <AppIcon name="refresh" :size="14" />
        </button>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="pending && !data" class="stack">
      <span class="skeleton" style="width: 100%; height: 90px" />
      <span class="skeleton" style="width: 100%; height: 90px" />
    </div>

    <!-- Error -->
    <div v-else-if="error" class="empty">
      <span class="empty-icon"><AppIcon name="alert" :size="20" /></span>
      <span class="empty-title">โหลด metrics ไม่สำเร็จ</span>
      <button class="secondary" @click="refresh()">ลองใหม่</button>
    </div>

    <!-- ยังไม่มีข้อมูล -->
    <div v-else-if="!latest" class="empty">
      <span class="empty-icon"><AppIcon name="activity" :size="20" /></span>
      <span class="empty-title">ยังไม่มีข้อมูลการใช้ทรัพยากร</span>
      <p class="small">
        เก็บได้เฉพาะ project ที่มี container ทำงานอยู่ — deploy แล้วรอประมาณ 15 วินาที
      </p>
    </div>

    <template v-else>
      <!-- แจ้งเมื่อ container ไม่ได้ทำงาน: ตัวเลขที่เห็นเป็นค่าสุดท้ายก่อนหยุด -->
      <div v-if="!latest.running" class="alert alert-warn">
        <AppIcon name="info" :size="16" />
        <span>container ไม่ได้ทำงานอยู่ — ตัวเลขด้านล่างเป็นค่าล่าสุดที่วัดได้ก่อนหยุด</span>
      </div>

      <div class="metric-grid">
        <!-- CPU -->
        <div class="inset metric">
          <div class="metric-head">
            <span class="eyebrow">CPU</span>
            <span v-if="cpuPeak !== null" class="badge tiny">
              สูงสุด {{ formatPercent(cpuPeak) }}
            </span>
          </div>
          <p class="metric-value">{{ formatPercent(latest.cpuPercent) }}</p>
          <p class="metric-sub muted tiny">เทียบกับ 1 core = 100%</p>
          <MetricChart :points="cpuSeries" :gap-ms="gapMs" tone="accent" :height="72" />
        </div>

        <!-- Memory -->
        <div class="inset metric">
          <div class="metric-head">
            <span class="eyebrow">หน่วยความจำ</span>
            <span class="badge tiny">
              {{ latest.memLimitBytes > 0 ? `จำกัด ${formatBytes(latest.memLimitBytes)}` : "ไม่จำกัด" }}
            </span>
          </div>
          <p class="metric-value" :class="memPercent !== null ? `v-${usageTone(memPercent)}` : ''">
            {{ formatBytes(latest.memUsedBytes) }}
          </p>
          <p class="metric-sub muted tiny">
            {{ memPercent !== null ? `${formatPercent(memPercent)} ของ limit` : "ไม่ได้ตั้ง memory limit" }}
          </p>
          <MetricChart
            :points="memSeries"
            :max="latest.memLimitBytes > 0 ? latest.memLimitBytes : undefined"
            :gap-ms="gapMs"
            :tone="memPercent !== null ? usageTone(memPercent) : 'accent'"
            :height="72"
          />
        </div>
      </div>

      <dl class="kv">
        <dt>สถานะ container</dt>
        <dd>
          <span class="status" :class="latest.running ? 'status-running' : 'status-stopped'">
            {{ latest.running ? "ทำงานอยู่" : "หยุดแล้ว" }}
          </span>
        </dd>
        <dt>Restart สะสม</dt>
        <dd>
          {{ latest.restartCount }}
          <span v-if="restartsInRange > 0" class="bad-text small">
            (+{{ restartsInRange }} ในช่วงที่ดู)
          </span>
        </dd>
        <dt>วัดล่าสุด</dt>
        <dd :title="fullDateTime(latest.ts)">{{ timeAgo(latest.ts) }}</dd>
      </dl>
    </template>
  </div>
</template>

<style scoped>
.range-switch {
  display: flex;
  gap: 2px;
  padding: 3px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r);
}
.range-btn {
  height: 24px;
  padding: 0 var(--s-2);
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-muted);
  font-size: var(--t-xs);
  border-radius: var(--r-sm);
}
.range-btn:hover:not(.active) {
  background: var(--surface-2);
  border-color: transparent;
  color: var(--text-secondary);
}
.range-btn.active {
  background: var(--surface-3);
  color: var(--text);
  font-weight: 550;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--s-3);
}

.metric {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.metric-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2);
}
.metric-value {
  font-size: var(--t-xl);
  font-weight: 650;
  line-height: 1.15;
  letter-spacing: -0.02em;
}
.v-warn {
  color: var(--warn);
}
.v-bad {
  color: var(--bad);
}
.metric-sub {
  margin-top: -0.15rem;
}
</style>
