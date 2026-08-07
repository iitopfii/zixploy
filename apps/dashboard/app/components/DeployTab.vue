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

function fmtDuration(start: number | null, end: number | null) {
  if (!start || !end) return null;
  const s = Math.round((end - start) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
</script>

<template>
  <div class="stack-lg">
    <!-- Action buttons -->
    <div class="stack">
      <div v-if="!archived" class="actions">
        <button class="primary" :disabled="!!busy || !hasSource" @click="deploy">
          <span v-if="busy === 'Deploy'" class="spinner" />
          <AppIcon v-else name="rotate" :size="15" />
          {{ busy === "Deploy" ? "กำลัง deploy…" : "Deploy" }}
        </button>
        <button class="secondary" :disabled="!!busy || deployments.length === 0" @click="redeploy">
          <span v-if="busy === 'Redeploy'" class="spinner" />
          {{ busy === "Redeploy" ? "กำลัง…" : "Redeploy" }}
        </button>
        <button class="secondary" :disabled="!!busy" @click="restart">
          <span v-if="busy === 'Restart'" class="spinner" />
          {{ busy === "Restart" ? "กำลัง…" : "Restart" }}
        </button>
        <button class="danger" :disabled="!!busy" @click="stop">
          <span v-if="busy === 'Stop'" class="spinner" />
          <AppIcon v-else name="stop" :size="14" />
          {{ busy === "Stop" ? "กำลัง…" : "Stop" }}
        </button>
      </div>
      <p v-if="!hasSource" class="alert alert-warn">
        <AppIcon name="alert" :size="15" />
        <span>ตั้งค่า Source repository ก่อนจึงจะ Deploy ได้</span>
      </p>

      <p v-if="actionError" class="alert alert-bad">
        <AppIcon name="alert" :size="15" />
        <span>{{ actionError }}</span>
      </p>
      <p v-if="actionOk" class="alert alert-ok">
        <AppIcon name="check" :size="15" />
        <span>{{ actionOk }}</span>
      </p>
    </div>

    <!-- Deployment list -->
    <div>
      <div class="row-between section-head">
        <h2 class="section-title">ประวัติ Deployment</h2>
        <button class="ghost small icon" :disabled="loadingList" title="รีเฟรช" aria-label="รีเฟรช" @click="fetchDeployments()">
          <AppIcon name="refresh" :size="14" />
        </button>
      </div>

      <div v-if="loadingList" class="stack">
        <span class="skeleton" style="height: 64px" />
        <span class="skeleton" style="height: 64px" />
      </div>
      <p v-else-if="listError" class="alert alert-bad">
        <AppIcon name="alert" :size="15" />
        <span>{{ listError }}</span>
      </p>
      <div v-else-if="deployments.length === 0" class="empty">
        <span class="empty-icon"><AppIcon name="rotate" :size="20" /></span>
        <span class="empty-title">ยังไม่เคย deploy</span>
      </div>

      <ul v-else class="deploy-list">
        <li v-for="d in deployments" :key="d.id" class="inset deploy-item">
          <div class="deploy-header">
            <span class="status" :class="`status-${d.status}`">{{ d.status }}</span>
            <code class="mono small">{{ shortSha(d.commitSha) }}</code>
            <span class="meta muted small">{{ d.trigger }}</span>
            <span class="meta muted small" :title="fullDateTime(d.queuedAt)">
              {{ timeAgo(d.queuedAt) }}
            </span>
            <span v-if="fmtDuration(d.startedAt, d.finishedAt)" class="meta muted small">
              <AppIcon name="clock" :size="11" />
              {{ fmtDuration(d.startedAt, d.finishedAt) }}
            </span>
          </div>

          <p v-if="d.commitMessage" class="commit-msg truncate">{{ d.commitMessage }}</p>

          <p v-if="d.status === 'failed' && d.failureMessage" class="alert alert-bad small">
            <AppIcon name="alert" :size="13" />
            <span>{{ d.failureCode }}: {{ d.failureMessage }}</span>
          </p>

          <div v-if="!archived" class="deploy-item-actions">
            <button
              v-if="IN_FLIGHT.includes(d.status)"
              class="danger tiny"
              :disabled="!!busy"
              @click="cancel(d.id)"
            >
              Cancel
            </button>
            <button
              v-if="d.status === 'succeeded'"
              class="secondary tiny"
              :disabled="!!busy"
              @click="rollback(d.id)"
            >
              Rollback
            </button>
          </div>
        </li>
      </ul>

      <button
        v-if="nextCursor && !loadingList"
        class="secondary small load-more"
        @click="fetchDeployments(nextCursor)"
      >
        โหลดเพิ่มเติม…
      </button>
    </div>
  </div>
</template>

<style scoped>
.section-head {
  margin-bottom: var(--s-3);
}

.deploy-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.deploy-item {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.deploy-header {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  flex-wrap: wrap;
}
.meta {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
.commit-msg {
  margin: 0;
  font-size: var(--t-sm);
  color: var(--text-secondary);
}
.deploy-item-actions {
  display: flex;
  gap: var(--s-2);
}
.load-more {
  margin-top: var(--s-3);
}
</style>
