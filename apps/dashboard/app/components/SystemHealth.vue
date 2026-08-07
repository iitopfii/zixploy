<script setup lang="ts">
/**
 * ตัวบอกสถานะระบบ (database + worker) — poll ทุก 30 วิ
 *
 * compact=true  → pill เดี่ยว ใช้บน mobile topbar ที่พื้นที่จำกัด
 * compact=false → กล่องแยกราย component ใช้ท้าย sidebar
 */
withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

const api = useApi();

const { data: health, refresh } = await useAsyncData(
  "system-health",
  async () => (await api.api.v1.system.health.get()).data,
  { server: false, lazy: true },
);

// poll เบา ๆ ให้สถานะสดโดยไม่ต้อง refresh หน้า — เคลียร์ตอน unmount กัน timer รั่ว
onMounted(() => {
  const timer = setInterval(() => refresh(), 30_000);
  onUnmounted(() => clearInterval(timer));
});

const dbOk = computed(() => health.value?.checks.database.ready ?? false);
const workerOk = computed(() => health.value?.checks.worker.ready ?? false);
const allOk = computed(() => health.value?.status === "ok");

const tone = computed(() => {
  if (!health.value) return "status-unknown";
  return allOk.value ? "status-running" : "status-failed";
});

const label = computed(() => {
  if (!health.value) return "กำลังตรวจ…";
  if (allOk.value) return "ระบบปกติ";
  const down = [!dbOk.value && "database", !workerOk.value && "worker"].filter(Boolean);
  return `ขัดข้อง: ${down.join(", ")}`;
});
</script>

<template>
  <span v-if="compact" class="status" :class="tone" :title="label">
    {{ allOk ? "ปกติ" : "ขัดข้อง" }}
  </span>

  <div v-else class="health">
    <div class="health-head">
      <span class="eyebrow">สถานะระบบ</span>
      <span class="status" :class="tone">{{ label }}</span>
    </div>
    <div class="checks">
      <span class="check" :class="dbOk ? 'ok' : 'bad'">
        <AppIcon name="database" :size="13" />
        <span>Database</span>
      </span>
      <span class="check" :class="workerOk ? 'ok' : 'bad'">
        <AppIcon name="activity" :size="13" />
        <span>Worker</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.health {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-3);
  background: var(--surface-1);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r);
}

.health-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2);
}

.checks {
  display: flex;
  gap: var(--s-3);
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: var(--t-xs);
  color: var(--text-muted);
}
.check.ok {
  color: var(--text-secondary);
}
.check.ok :deep(.icon) {
  color: var(--ok);
}
.check.bad {
  color: var(--bad);
}
</style>
