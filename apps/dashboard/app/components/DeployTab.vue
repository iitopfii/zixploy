<script setup lang="ts">
/**
 * Deploy Tab — Phase 3
 *
 * Actions: deploy, redeploy, restart, stop, rollback, cancel
 * History: deployment list with status, timestamps, rollback button
 */
const props = defineProps<{ projectId: string; hasSource: boolean; archived: boolean }>();

const api = useApi();

// ---------------------------------------------------------------------------
// Deployment list
// ---------------------------------------------------------------------------

interface Deployment {
  id: string;
  status: string;
  trigger: string;
  commitSha: string;
  commitMessage: string | null;
  commitAuthor: string | null;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  failureCode: string | null;
  failureMessage: string | null;
}

const deployments = ref<Deployment[]>([]);
const nextCursor = ref<string | undefined>(undefined);
const loadingList = ref(true);
const listError = ref("");

async function fetchDeployments(cursor?: string) {
  listError.value = "";
  try {
    const { data, error } = await api.api.v1.projects({ id: props.projectId }).deployments.get({
      query: cursor ? { cursor } : {},
    });
    if (error) {
      listError.value = "โหลดรายการ deploy ไม่ได้";
      return;
    }
    if (cursor) {
      deployments.value.push(...(data?.items ?? []));
    } else {
      deployments.value = data?.items ?? [];
    }
    nextCursor.value = data?.nextCursor;
  } catch {
    listError.value = "ติดต่อ API ไม่ได้";
  } finally {
    loadingList.value = false;
  }
}

await fetchDeployments();

// poll for in-flight deployments
const IN_FLIGHT = ["queued", "cloning", "building", "starting", "health_checking", "activating"];
const hasInFlight = computed(() => deployments.value.some((d) => IN_FLIGHT.includes(d.status)));

let pollTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  if (hasInFlight.value) {
    pollTimer = setTimeout(async () => {
      await fetchDeployments();
      schedulePoll();
    }, 3000);
  }
}

watch(hasInFlight, schedulePoll, { immediate: true });
onUnmounted(() => {
  if (pollTimer) clearTimeout(pollTimer);
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const busy = ref<string | null>(null); // tracks which action is running
const actionError = ref("");
const actionOk = ref("");

async function doAction(label: string, fn: () => Promise<void>) {
  busy.value = label;
  actionError.value = "";
  actionOk.value = "";
  try {
    await fn();
    actionOk.value = `${label} สำเร็จ`;
    await fetchDeployments();
    schedulePoll();
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : "เกิดข้อผิดพลาด";
  } finally {
    busy.value = null;
  }
}

async function deploy() {
  await doAction("Deploy", async () => {
    const { error } = await api.api.v1.projects({ id: props.projectId }).deploy.post({});
    if (error)
      throw new Error(
        (error.value as { error?: { message?: string } } | null)?.error?.message ?? "deploy ล้มเหลว",
      );
  });
}

async function redeploy() {
  await doAction("Redeploy", async () => {
    const { error } = await api.api.v1.projects({ id: props.projectId }).redeploy.post({});
    if (error)
      throw new Error(
        (error.value as { error?: { message?: string } } | null)?.error?.message ??
          "redeploy ล้มเหลว",
      );
  });
}

async function restart() {
  await doAction("Restart", async () => {
    const { error } = await api.api.v1.projects({ id: props.projectId }).restart.post({});
    if (error)
      throw new Error(
        (error.value as { error?: { message?: string } } | null)?.error?.message ??
          "restart ล้มเหลว",
      );
  });
}

async function stop() {
  await doAction("Stop", async () => {
    const { error } = await api.api.v1.projects({ id: props.projectId }).stop.post({});
    if (error)
      throw new Error(
        (error.value as { error?: { message?: string } } | null)?.error?.message ?? "stop ล้มเหลว",
      );
  });
}

async function rollback(targetDeploymentId: string) {
  await doAction("Rollback", async () => {
    const { error } = await api.api.v1
      .projects({ id: props.projectId })
      .rollback.post({ targetDeploymentId });
    if (error)
      throw new Error(
        (error.value as { error?: { message?: string } } | null)?.error?.message ??
          "rollback ล้มเหลว",
      );
  });
}

async function cancel(deploymentId: string) {
  await doAction("Cancel", async () => {
    const { error } = await api.api.v1.deployments({ id: deploymentId }).cancel.post({});
    if (error)
      throw new Error(
        (error.value as { error?: { message?: string } } | null)?.error?.message ?? "cancel ล้มเหลว",
      );
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusClass(s: string) {
  if (s === "succeeded") return "badge-ok";
  if (s === "failed" || s === "cancelled") return "badge-err";
  return "badge-run";
}

function fmtTime(ms: number | null) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" });
}

function fmtDuration(start: number | null, end: number | null) {
  if (!start || !end) return null;
  const s = Math.round((end - start) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function shortSha(sha: string) {
  return sha.slice(0, 7);
}
</script>

<template>
  <div class="deploy-tab">
    <!-- Action buttons -->
    <div v-if="!archived" class="actions-row">
      <button class="primary" :disabled="!!busy || !hasSource" @click="deploy">
        {{ busy === 'Deploy' ? 'กำลัง deploy…' : 'Deploy' }}
      </button>
      <button :disabled="!!busy || deployments.length === 0" @click="redeploy">
        {{ busy === 'Redeploy' ? 'กำลัง…' : 'Redeploy' }}
      </button>
      <button :disabled="!!busy" @click="restart">
        {{ busy === 'Restart' ? 'กำลัง…' : 'Restart' }}
      </button>
      <button class="danger" :disabled="!!busy" @click="stop">
        {{ busy === 'Stop' ? 'กำลัง…' : 'Stop' }}
      </button>
    </div>
    <p v-if="!hasSource" class="muted small">⚠️ ตั้งค่า Source repository ก่อนจึงจะ Deploy ได้</p>

    <p v-if="actionError" class="error-text">{{ actionError }}</p>
    <p v-if="actionOk" class="ok-text">✓ {{ actionOk }}</p>

    <!-- Deployment list -->
    <div class="section-head">
      <h2 class="section-title">ประวัติ Deployment</h2>
      <button class="secondary small" :disabled="loadingList" @click="fetchDeployments()">↺ รีเฟรช</button>
    </div>

    <p v-if="loadingList" class="muted">กำลังโหลด…</p>
    <p v-else-if="listError" class="error-text">{{ listError }}</p>
    <p v-else-if="deployments.length === 0" class="muted">ยังไม่เคย deploy</p>

    <ul v-else class="deploy-list">
      <li v-for="d in deployments" :key="d.id" class="deploy-item">
        <div class="deploy-header">
          <span class="badge" :class="statusClass(d.status)">{{ d.status }}</span>
          <code class="sha">{{ shortSha(d.commitSha) }}</code>
          <span class="trigger muted">{{ d.trigger }}</span>
          <span class="time muted">{{ fmtTime(d.queuedAt) }}</span>
          <span v-if="fmtDuration(d.startedAt, d.finishedAt)" class="duration muted">
            {{ fmtDuration(d.startedAt, d.finishedAt) }}
          </span>
        </div>

        <p v-if="d.commitMessage" class="commit-msg">{{ d.commitMessage }}</p>

        <p v-if="d.status === 'failed' && d.failureMessage" class="error-text small">
          {{ d.failureCode }}: {{ d.failureMessage }}
        </p>

        <div v-if="!archived" class="deploy-item-actions">
          <button
            v-if="IN_FLIGHT.includes(d.status)"
            class="danger small"
            :disabled="!!busy"
            @click="cancel(d.id)"
          >Cancel</button>
          <button
            v-if="d.status === 'succeeded'"
            class="secondary small"
            :disabled="!!busy"
            @click="rollback(d.id)"
          >Rollback</button>
        </div>
      </li>
    </ul>

    <button
      v-if="nextCursor && !loadingList"
      class="secondary small"
      @click="fetchDeployments(nextCursor)"
    >โหลดเพิ่มเติม…</button>
  </div>
</template>

<style scoped>
.deploy-tab { display: flex; flex-direction: column; gap: 1rem; }
.actions-row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.section-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-top: 0.5rem; }
.section-title { margin: 0; font-size: 1rem; font-weight: 600; }

.deploy-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.deploy-item {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.75rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.deploy-header { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
.badge { font-size: 0.75rem; padding: 0.15rem 0.5rem; border-radius: 999px; font-weight: 600; }
.badge-ok { background: var(--success-bg, #d1fae5); color: var(--success, #065f46); }
.badge-err { background: var(--error-bg, #fee2e2); color: var(--error, #991b1b); }
.badge-run { background: var(--accent-bg, #dbeafe); color: var(--accent); }
.sha { font-size: 0.8rem; }
.trigger, .time, .duration { font-size: 0.8rem; }
.commit-msg { margin: 0; font-size: 0.85rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.deploy-item-actions { display: flex; gap: 0.5rem; }

@media (prefers-color-scheme: dark) {
  .badge-ok { background: #064e3b; color: #6ee7b7; }
  .badge-err { background: #7f1d1d; color: #fca5a5; }
  .badge-run { background: #1e3a5f; color: #93c5fd; }
}
:root[data-theme="dark"] .badge-ok { background: #064e3b; color: #6ee7b7; }
:root[data-theme="dark"] .badge-err { background: #7f1d1d; color: #fca5a5; }
:root[data-theme="dark"] .badge-run { background: #1e3a5f; color: #93c5fd; }
</style>
