<script setup lang="ts">
/**
 * Server monitoring — Phase 9 M4
 *
 * ข้อมูลทั้งหมดมาจาก /system/metrics ซึ่งอ่านจาก SQLite ที่ deploy-worker เขียนไว้
 * (control-api ไม่แตะ Docker หรือ /proc เอง ตาม ADR-0002)
 */
const api = useApi();

type Range = "1h" | "6h" | "24h";
const range = ref<Range>("1h");
const ranges: Array<{ key: Range; label: string }> = [
  { key: "1h", label: "1 ชม." },
  { key: "6h", label: "6 ชม." },
  { key: "24h", label: "24 ชม." },
];

const { data, pending, error, refresh } = await useAsyncData(
  "system-metrics",
  async () => {
    const { data: body, error: apiError } = await api.api.v1.system.metrics.get({
      query: { range: range.value },
    });
    if (apiError) throw new Error("โหลด metrics ไม่สำเร็จ");
    return body;
  },
  { server: false, watch: [range] },
);

// รีเฟรชอัตโนมัติให้ตัวเลขสด — เท่ากับความถี่ที่ worker เก็บจริง (ไม่ต้องถี่กว่านั้น)
onMounted(() => {
  const timer = setInterval(() => refresh(), 15_000);
  onUnmounted(() => clearInterval(timer));
});

const latest = computed(() => data.value?.latest ?? null);
const points = computed(() => data.value?.points ?? []);

/** ช่องว่างเกิน 3 เท่าของ sample interval = worker หยุดช่วงนั้นจริง ไม่ใช่แค่จังหวะคลาดกัน */
const gapMs = computed(() => (data.value?.range.sampleIntervalMs ?? 15_000) * 3);

const memPercent = computed(() =>
  latest.value ? ratioPercent(latest.value.memUsedBytes, latest.value.memTotalBytes) : 0,
);
const diskPercent = computed(() =>
  latest.value ? ratioPercent(latest.value.diskUsedBytes, latest.value.diskTotalBytes) : 0,
);

/** load average เทียบจำนวน core — 1.0 ต่อ core = ใช้เต็มพอดี */
const loadPercent = computed(() =>
  latest.value ? Math.min(100, (latest.value.load1 / latest.value.cpuCount) * 100) : 0,
);

const cpuSeries = computed(() => points.value.map((p) => ({ ts: p.ts, value: p.cpuPercent })));
const memSeries = computed(() =>
  points.value.map((p) => ({ ts: p.ts, value: ratioPercent(p.memUsedBytes, p.memTotalBytes) })),
);
const diskSeries = computed(() =>
  points.value.map((p) => ({ ts: p.ts, value: ratioPercent(p.diskUsedBytes, p.diskTotalBytes) })),
);
const loadSeries = computed(() => points.value.map((p) => ({ ts: p.ts, value: p.load1 })));

/** ข้อมูลล่าสุดเก่ากว่า 2 นาที = worker ไม่ได้เก็บอยู่ */
const stale = computed(() => !!latest.value && Date.now() - latest.value.ts > 120_000);

// ---------------------------------------------------------------------------
// ล้าง cache (Phase 11)
// ---------------------------------------------------------------------------

const { data: maintenance, refresh: refreshMaintenance } = await useAsyncData(
  "maintenance",
  async () => (await api.api.v1.system.maintenance.get()).data,
  { server: false },
);

const cleaning = computed(() => maintenance.value?.active != null);
const cleanError = ref("");

/** poll ถี่ระหว่างล้างอยู่ — prune ใช้เวลาได้หลายสิบวินาที */
onMounted(() => {
  let timer: ReturnType<typeof setInterval> | null = null;
  watch(
    cleaning,
    (busy) => {
      if (timer) clearInterval(timer);
      if (busy) timer = setInterval(() => refreshMaintenance(), 3_000);
    },
    { immediate: true },
  );
  onUnmounted(() => timer && clearInterval(timer));
});

async function cleanCache() {
  cleanError.value = "";
  try {
    const { error } = await api.api.v1.system.maintenance.cleanup.post({ type: "prune_all" });
    if (error) {
      const body = error.value as { error?: { message?: string } } | null;
      cleanError.value = body?.error?.message ?? "สั่งล้างไม่สำเร็จ";
      return;
    }
    await refreshMaintenance();
  } catch {
    cleanError.value = "ติดต่อ API ไม่ได้";
  }
}

/** งานล่าสุดที่จบแล้ว — แสดงผลลัพธ์ครั้งก่อน */
const lastCleanup = computed(
  () =>
    (maintenance.value?.recent ?? []).find((j) => j.status === "done" || j.status === "failed") ??
    null,
);
</script>

<template>
  <div class="stack-lg">
    <header class="page-head">
      <div>
        <h1>Monitoring</h1>
        <p class="muted small">ทรัพยากรของเซิร์ฟเวอร์ที่รัน Zixploy</p>
      </div>
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
        <button class="secondary icon" title="โหลดใหม่" aria-label="โหลดใหม่" @click="refresh()">
          <AppIcon name="refresh" :size="15" />
        </button>
      </div>
    </header>

    <div v-if="stale" class="alert alert-warn">
      <AppIcon name="alert" :size="16" />
      <span>
        ข้อมูลล่าสุดเมื่อ {{ timeAgo(latest?.ts) }} — deploy worker อาจหยุดทำงาน
        ตรวจสอบสถานะ worker ที่แถบด้านซ้าย
      </span>
    </div>

    <!-- Loading -->
    <div v-if="pending && !data" class="metric-grid">
      <div v-for="n in 4" :key="n" class="card metric-skeleton">
        <span class="skeleton" style="width: 40%; height: 0.9em" />
        <span class="skeleton" style="width: 55%; height: 1.8em" />
        <span class="skeleton" style="width: 100%; height: 64px" />
      </div>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="card">
      <div class="empty">
        <span class="empty-icon"><AppIcon name="alert" :size="20" /></span>
        <span class="empty-title">โหลด metrics ไม่สำเร็จ</span>
        <button class="secondary" @click="refresh()">
          <AppIcon name="refresh" :size="15" />
          ลองใหม่
        </button>
      </div>
    </div>

    <!-- ยังไม่เคยเก็บ metrics เลย -->
    <div v-else-if="!latest" class="card">
      <div class="empty">
        <span class="empty-icon"><AppIcon name="activity" :size="20" /></span>
        <span class="empty-title">ยังไม่มีข้อมูล metrics</span>
        <p class="small">
          deploy worker เก็บตัวอย่างทุก 15 วินาที — รอสักครู่แล้วโหลดใหม่
          ถ้ายังไม่ขึ้น ให้ตรวจว่า worker ทำงานอยู่
        </p>
        <button class="secondary" @click="refresh()">
          <AppIcon name="refresh" :size="15" />
          โหลดใหม่
        </button>
      </div>
    </div>

    <template v-else>
      <div class="metric-grid">
        <!-- CPU -->
        <section class="card metric">
          <div class="metric-head">
            <span class="eyebrow">CPU</span>
            <span class="badge tiny">{{ latest.cpuCount }} core</span>
          </div>
          <p class="metric-value" :class="`v-${usageTone(latest.cpuPercent)}`">
            {{ formatPercent(latest.cpuPercent) }}
          </p>
          <MetricChart
            :points="cpuSeries"
            :max="100"
            :gap-ms="gapMs"
            :tone="usageTone(latest.cpuPercent)"
          />
        </section>

        <!-- Memory -->
        <section class="card metric">
          <div class="metric-head">
            <span class="eyebrow">หน่วยความจำ</span>
            <span class="badge tiny">{{ formatBytes(latest.memTotalBytes) }}</span>
          </div>
          <p class="metric-value" :class="`v-${usageTone(memPercent)}`">
            {{ formatPercent(memPercent) }}
          </p>
          <p class="metric-sub muted tiny">
            ใช้ {{ formatBytes(latest.memUsedBytes) }} จาก {{ formatBytes(latest.memTotalBytes) }}
          </p>
          <MetricChart
            :points="memSeries"
            :max="100"
            :gap-ms="gapMs"
            :tone="usageTone(memPercent)"
          />
        </section>

        <!-- Disk -->
        <section class="card metric">
          <div class="metric-head">
            <span class="eyebrow">ดิสก์</span>
            <span class="badge tiny">{{ formatBytes(latest.diskTotalBytes) }}</span>
          </div>
          <p class="metric-value" :class="`v-${usageTone(diskPercent)}`">
            {{ formatPercent(diskPercent) }}
          </p>
          <p class="metric-sub muted tiny">
            เหลือ {{ formatBytes(latest.diskTotalBytes - latest.diskUsedBytes) }} ว่าง
          </p>
          <MetricChart
            :points="diskSeries"
            :max="100"
            :gap-ms="gapMs"
            :tone="usageTone(diskPercent)"
          />
        </section>

        <!-- Load average -->
        <section class="card metric">
          <div class="metric-head">
            <span class="eyebrow">Load average</span>
            <span class="badge tiny">1 / 5 / 15 นาที</span>
          </div>
          <p class="metric-value" :class="`v-${usageTone(loadPercent)}`">
            {{ latest.load1.toFixed(2) }}
          </p>
          <p class="metric-sub muted tiny">
            {{ latest.load5.toFixed(2) }} · {{ latest.load15.toFixed(2) }}
            <span class="sep">·</span>
            {{ loadPercent >= 100 ? "เกินกำลังเครื่อง" : `${Math.round(loadPercent)}% ของ ${latest.cpuCount} core` }}
          </p>
          <MetricChart
            :points="loadSeries"
            :gap-ms="gapMs"
            :tone="usageTone(loadPercent)"
          />
        </section>
      </div>

      <p class="muted tiny foot">
        <AppIcon name="clock" :size="12" />
        เก็บตัวอย่างทุก {{ Math.round((data?.range.sampleIntervalMs ?? 15000) / 1000) }} วินาที
        · อัปเดตล่าสุด {{ timeAgo(latest.ts) }}
        · แสดง {{ points.length }} จุด
      </p>
    </template>

    <!-- ── ล้าง cache ──
         อยู่หน้าเดียวกับกราฟดิสก์โดยตั้งใจ: เห็นดิสก์ใกล้เต็มแล้วกดล้างได้ทันที -->
    <section class="card stack">
      <div class="row-between wrap">
        <div>
          <h2 class="section-title">ล้างพื้นที่ดิสก์</h2>
          <p class="muted small clean-desc">
            ลบ build cache ที่เก่ากว่า 7 วัน และ image ที่ไม่มีอะไรใช้แล้ว
            — ไม่แตะ image ของ deployment ที่ rollback ได้ และไม่แตะ database ที่หยุดอยู่
          </p>
        </div>
        <button class="secondary" :disabled="cleaning" @click="cleanCache">
          <span v-if="cleaning" class="spinner" />
          <AppIcon v-else name="trash" :size="15" />
          {{ cleaning ? "กำลังล้าง…" : "ล้าง cache" }}
        </button>
      </div>

      <p v-if="cleanError" class="alert alert-bad">
        <AppIcon name="alert" :size="15" />
        <span>{{ cleanError }}</span>
      </p>

      <p v-if="cleaning" class="alert alert-info">
        <AppIcon name="info" :size="15" />
        <span>กำลังล้าง — อาจใช้เวลาสักครู่ ระหว่างนี้ deploy ยังทำงานได้ปกติ</span>
      </p>

      <div v-else-if="lastCleanup" class="inset last-clean">
        <template v-if="lastCleanup.status === 'done'">
          <AppIcon name="check" :size="15" class="ok-text" />
          <span class="small">
            ล้างล่าสุด {{ timeAgo(lastCleanup.finishedAt) }} — คืนพื้นที่ได้
            <strong>{{ formatBytes(lastCleanup.reclaimedBytes ?? 0) }}</strong>
            <span v-if="lastCleanup.summary" class="muted"> ({{ lastCleanup.summary }})</span>
          </span>
        </template>
        <template v-else>
          <AppIcon name="alert" :size="15" class="bad-text" />
          <span class="small">
            ล้างล่าสุด {{ timeAgo(lastCleanup.finishedAt) }} ไม่สำเร็จ —
            {{ lastCleanup.failureMessage }}
          </span>
        </template>
      </div>
    </section>
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

/* segmented control เลือกช่วงเวลา */
.range-switch {
  display: flex;
  gap: 2px;
  padding: 3px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r);
}
.range-btn {
  height: 26px;
  padding: 0 var(--s-3);
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
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: var(--s-4);
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
  font-size: var(--t-2xl);
  font-weight: 650;
  line-height: 1.1;
  letter-spacing: -0.02em;
}
.v-ok {
  color: var(--text);
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

.metric-skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}

.foot {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
}

/* ── ล้าง cache ── */
.clean-desc {
  margin-top: 0.2rem;
  max-width: 62ch;
}
.last-clean {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}
</style>
