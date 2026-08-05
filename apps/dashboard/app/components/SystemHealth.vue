<script setup lang="ts">
const api = useApi();

const { data: health } = await useAsyncData(
  "system-health",
  async () => (await api.api.v1.system.health.get()).data,
  { server: false, lazy: true },
);

const label = computed(() => {
  if (!health.value) return "checking…";
  if (health.value.status === "ok") return "healthy";
  const down: string[] = [];
  if (!health.value.checks.database.ready) down.push("database");
  if (!health.value.checks.worker.ready) down.push("worker");
  return `degraded: ${down.join(", ")}`;
});

const tone = computed(() => (health.value?.status === "ok" ? "status-running" : "status-failed"));
</script>

<template>
  <span class="status" :class="tone" :title="label">{{ label }}</span>
</template>
