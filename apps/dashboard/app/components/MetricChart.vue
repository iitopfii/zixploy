<script setup lang="ts">
/**
 * กราฟเส้นพื้นที่สำหรับ time-series — inline SVG ไม่พึ่ง chart library
 *
 * ออกแบบให้ responsive ด้วย viewBox + preserveAspectRatio="none": SVG ยืดตามความกว้าง
 * ของ container โดยไม่ต้องวัด DOM หรือ resize observer (เส้นจะถูกยืดตามแนวนอนด้วย
 * จึงตั้ง vector-effect="non-scaling-stroke" ไม่ให้ความหนาเส้นเพี้ยน)
 *
 * ค่าที่ขาดช่วง (worker หยุด/รีสตาร์ท) ถูกตัดเป็นเส้นแยกไม่ลากข้าม — ลากข้ามจะอ่านเหมือน
 * ระบบทำงานต่อเนื่องทั้งที่ไม่มีข้อมูลช่วงนั้น
 */

const props = withDefaults(
  defineProps<{
    points: Array<{ ts: number; value: number }>;
    /** ค่าสูงสุดของแกน Y — ไม่ระบุ = ใช้ค่าสูงสุดในชุดข้อมูล (auto scale) */
    max?: number;
    /** ระยะห่างสูงสุดระหว่างจุดก่อนถือว่าข้อมูลขาดช่วง */
    gapMs?: number;
    tone?: "accent" | "ok" | "warn" | "bad";
    height?: number;
    /** ฟอร์แมตค่าใน tooltip/แกน */
    format?: (value: number) => string;
  }>(),
  { tone: "accent", height: 64, gapMs: 60_000 },
);

const VIEW_W = 1000;
const VIEW_H = 100;

/** ค่าสูงสุดที่ใช้สเกล — บวก headroom 10% ให้ยอดไม่ชนขอบบนพอดีจนดูเหมือนถูกตัด */
const scaleMax = computed(() => {
  if (props.max !== undefined) return props.max;
  const peak = Math.max(...props.points.map((p) => p.value), 0);
  return peak <= 0 ? 1 : peak * 1.1;
});

const bounds = computed(() => {
  const ts = props.points.map((p) => p.ts);
  const min = Math.min(...ts);
  const max = Math.max(...ts);
  // ข้อมูลจุดเดียว (หรือทุกจุดเวลาเดียวกัน) — span 0 จะทำให้หารศูนย์
  return { min, span: max - min || 1 };
});

function x(ts: number): number {
  return ((ts - bounds.value.min) / bounds.value.span) * VIEW_W;
}

function y(value: number): number {
  return VIEW_H - Math.min(1, Math.max(0, value / scaleMax.value)) * VIEW_H;
}

/** แบ่งจุดเป็นช่วง ๆ ตรงที่ข้อมูลขาด — แต่ละช่วงวาดเป็น path แยก */
const segments = computed(() => {
  const out: Array<Array<{ ts: number; value: number }>> = [];
  let current: Array<{ ts: number; value: number }> = [];

  for (const point of props.points) {
    const prev = current[current.length - 1];
    if (prev && point.ts - prev.ts > props.gapMs) {
      out.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length) out.push(current);
  return out;
});

/** เส้น + พื้นที่ใต้เส้น (ปิด path ลงถึงฐาน) ของแต่ละ segment */
const paths = computed(() =>
  segments.value.map((seg) => {
    const line = seg.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.ts)} ${y(p.value)}`).join(" ");
    const first = seg[0];
    const last = seg[seg.length - 1];
    // segment จุดเดียววาดพื้นที่ไม่ได้ (ไม่มีความกว้าง) — วาดแค่จุด
    const area =
      seg.length > 1 && first && last
        ? `${line} L${x(last.ts)} ${VIEW_H} L${x(first.ts)} ${VIEW_H} Z`
        : "";
    return { line, area, single: seg.length === 1 ? seg[0] : null };
  }),
);

const latest = computed(() => props.points[props.points.length - 1] ?? null);
</script>

<template>
  <div class="chart" :style="{ height: `${height}px` }">
    <svg
      v-if="points.length"
      :viewBox="`0 0 ${VIEW_W} ${VIEW_H}`"
      preserveAspectRatio="none"
      class="svg"
      :class="`tone-${tone}`"
      role="img"
      :aria-label="`กราฟ ${points.length} จุด ค่าล่าสุด ${format ? format(latest?.value ?? 0) : (latest?.value ?? 0)}`"
    >
      <defs>
        <linearGradient :id="`grad-${tone}`" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="currentColor" stop-opacity="0.28" />
          <stop offset="100%" stop-color="currentColor" stop-opacity="0" />
        </linearGradient>
      </defs>

      <!-- เส้นกริดแนวนอน 25/50/75% ให้กะระดับได้โดยไม่ต้องมีแกน Y เต็มรูปแบบ -->
      <g class="grid">
        <line v-for="p in [25, 50, 75]" :key="p" x1="0" :y1="p" :x2="VIEW_W" :y2="p" />
      </g>

      <g v-for="(path, i) in paths" :key="i">
        <path v-if="path.area" :d="path.area" :fill="`url(#grad-${tone})`" stroke="none" />
        <path
          v-if="!path.single"
          :d="path.line"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linejoin="round"
          stroke-linecap="round"
          vector-effect="non-scaling-stroke"
        />
        <circle
          v-else-if="path.single"
          :cx="x(path.single.ts)"
          :cy="y(path.single.value)"
          r="2"
          fill="currentColor"
          vector-effect="non-scaling-stroke"
        />
      </g>
    </svg>

    <div v-else class="chart-empty">
      <span class="tiny muted">ยังไม่มีข้อมูล</span>
    </div>
  </div>
</template>

<style scoped>
.chart {
  width: 100%;
  min-width: 0;
}

.svg {
  width: 100%;
  height: 100%;
  display: block;
  overflow: visible;
}

.tone-accent {
  color: var(--accent);
}
.tone-ok {
  color: var(--ok);
}
.tone-warn {
  color: var(--warn);
}
.tone-bad {
  color: var(--bad);
}

.grid line {
  stroke: var(--border-subtle);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.chart-empty {
  height: 100%;
  display: grid;
  place-items: center;
  border: 1px dashed var(--border-subtle);
  border-radius: var(--r-sm);
}
</style>
