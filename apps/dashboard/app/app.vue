<script setup lang="ts">
interface HealthCheck {
  ready: boolean;
  detail?: string;
}

interface Health {
  status: "ok" | "degraded";
  checks: { database: HealthCheck; worker: HealthCheck };
}

// System health indicator — โครงเริ่มต้นของ app shell (phase 1 จะเพิ่ม auth + navigation)
const { data: health, error } = await useFetch<Health>("/api/v1/system/health", {
  server: false,
  lazy: true,
});
</script>

<template>
  <main class="shell">
    <h1>Zixploy</h1>
    <p>Lightweight deployment platform — Phase 0 foundation</p>

    <section class="health">
      <h2>System Health</h2>
      <p v-if="error" class="bad">ติดต่อ Control API ไม่ได้ — เปิด `bun run dev:api` แล้วหรือยัง?</p>
      <template v-else-if="health">
        <p :class="health.status === 'ok' ? 'ok' : 'bad'">status: {{ health.status }}</p>
        <ul>
          <li :class="health.checks.database.ready ? 'ok' : 'bad'">
            database: {{ health.checks.database.ready ? "ready" : health.checks.database.detail }}
          </li>
          <li :class="health.checks.worker.ready ? 'ok' : 'bad'">
            worker: {{ health.checks.worker.ready ? "ready" : health.checks.worker.detail }}
          </li>
        </ul>
      </template>
      <p v-else>loading…</p>
    </section>
  </main>
</template>

<style>
body {
  font-family: ui-sans-serif, system-ui, sans-serif;
  margin: 0;
  background: #0b0e14;
  color: #e6e6e6;
}
.shell {
  max-width: 640px;
  margin: 4rem auto;
  padding: 0 1rem;
}
.health {
  margin-top: 2rem;
  padding: 1rem 1.5rem;
  border: 1px solid #2a2f3a;
  border-radius: 8px;
}
.ok {
  color: #4ade80;
}
.bad {
  color: #f87171;
}
</style>
