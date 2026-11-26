<script setup lang="ts">
const api = useApi();
const { t } = useI18n();
const { isAdmin } = usePermissions();

const {
  data: projects,
  pending,
  error,
  refresh,
} = await useAsyncData(
  "projects",
  async () => {
    const { data, error: apiError } = await api.api.v1.projects.get();
    if (apiError) throw new Error(t("projects.list.loadFailed"));
    return data?.items ?? [];
  },
  { server: false },
);

/**
 * สรุปจำนวนตามสถานะ — แถบบนสุดของหน้า ให้เห็นสุขภาพระบบรวมในแวบเดียว
 *
 * "กำลัง deploy" นับจาก activeDeployment ไม่ใช่ project.status เพราะสองอย่างนี้ตอบคนละคำถาม:
 * project.status บอกว่าแอปให้บริการอยู่ไหม ส่วน deployment บอกว่า build ไปถึงไหน
 * ระหว่าง build แอปเวอร์ชันเดิมยังรันอยู่ project.status จึงยังเป็น running/stopped ตามเดิม
 * (ADR-0004 — build ที่ล้มเหลวต้องไม่กระทบ container ที่ให้บริการอยู่)
 *
 * "ต้องดูแล" นับ degraded (container หายไปจริง) หรือ deploy ครั้งล่าสุดพัง
 */
const stats = computed(() => {
  const items = projects.value ?? [];
  return {
    total: items.length,
    running: items.filter((p) => p.status === "running" && !p.degraded).length,
    deploying: items.filter((p) => p.activeDeployment != null).length,
    attention: items.filter((p) => p.degraded || p.lastDeploymentStatus === "failed").length,
  };
});

const query = ref("");

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  const items = projects.value ?? [];
  if (!q) return items;
  return items.filter(
    (p) => p.name.toLowerCase().includes(q) || (p.repoFullName ?? "").toLowerCase().includes(q),
  );
});

// ── สร้าง project ใหม่ ──
const creating = ref(false);
const newName = ref("");
const createError = ref("");
const saving = ref(false);
const nameInput = ref<HTMLInputElement | null>(null);

async function openCreate() {
  creating.value = true;
  createError.value = "";
  await nextTick();
  nameInput.value?.focus();
}

async function create() {
  const name = newName.value.trim();
  if (!name) return;
  saving.value = true;
  createError.value = "";
  try {
    const { error: apiError } = await api.api.v1.projects.post({ name });
    if (apiError) {
      createError.value = apiErrorMessage(apiError, "projects.list.createFailed");
      return;
    }
    newName.value = "";
    creating.value = false;
    await refresh();
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="stack-lg">
    <!-- Page header -->
    <header class="page-head">
      <div>
        <h1>{{ $t("projects.list.title") }}</h1>
        <p class="muted small">{{ $t("projects.list.subtitle") }}</p>
      </div>
      <div class="actions">
        <button
          class="secondary icon"
          :title="$t('projects.list.reload')"
          :aria-label="$t('projects.list.reload')"
          @click="refresh()"
        >
          <AppIcon name="refresh" :size="15" />
        </button>
        <button v-if="isAdmin" class="primary" @click="openCreate">
          <AppIcon name="plus" :size="15" />
          {{ $t("projects.list.createButton") }}
        </button>
      </div>
    </header>

    <!-- Summary -->
    <div v-if="!error" class="stats">
      <div class="stat">
        <span class="stat-label">{{ $t("projects.list.stat.total") }}</span>
        <span class="stat-value">
          <span v-if="pending" class="skeleton stat-skeleton" />
          <template v-else>{{ stats.total }}</template>
        </span>
      </div>
      <div class="stat">
        <span class="stat-label">{{ $t("projects.list.stat.running") }}</span>
        <span class="stat-value tone-ok-text">
          <span v-if="pending" class="skeleton stat-skeleton" />
          <template v-else>{{ stats.running }}</template>
        </span>
      </div>
      <div class="stat">
        <span class="stat-label">{{ $t("projects.list.stat.deploying") }}</span>
        <span class="stat-value tone-info-text">
          <span v-if="pending" class="skeleton stat-skeleton" />
          <template v-else>{{ stats.deploying }}</template>
        </span>
      </div>
      <div class="stat" :class="{ alarm: stats.attention > 0 }">
        <span class="stat-label">{{ $t("projects.list.stat.attention") }}</span>
        <span class="stat-value" :class="stats.attention ? 'tone-bad-text' : ''">
          <span v-if="pending" class="skeleton stat-skeleton" />
          <template v-else>{{ stats.attention }}</template>
        </span>
      </div>
    </div>

    <!-- Create form -->
    <form v-if="creating && isAdmin" class="card create" @submit.prevent="create">
      <h2 class="section-title">{{ $t("projects.list.createTitle") }}</h2>
      <label>
        <span>{{ $t("projects.list.nameLabel") }}</span>
        <input
          ref="nameInput"
          v-model="newName"
          placeholder="my-app"
          maxlength="100"
          :disabled="saving"
        />
        <span class="field-hint">
          {{ $t("projects.list.createHint") }}
        </span>
      </label>
      <p v-if="createError" class="alert alert-bad">
        <AppIcon name="alert" :size="15" />
        <span>{{ createError }}</span>
      </p>
      <div class="actions-end">
        <button type="button" class="secondary" :disabled="saving" @click="creating = false">
          {{ $t("common.cancel") }}
        </button>
        <button class="primary" type="submit" :disabled="!newName.trim() || saving">
          <span v-if="saving" class="spinner" />
          {{ saving ? $t("common.creating") : $t("projects.list.createSubmit") }}
        </button>
      </div>
    </form>

    <!-- Search -->
    <div v-if="!pending && !error && (projects?.length ?? 0) > 4" class="search">
      <AppIcon name="search" :size="15" />
      <input v-model="query" :placeholder="$t('projects.list.searchPlaceholder')" />
    </div>

    <!-- Loading -->
    <div v-if="pending" class="grid">
      <div v-for="n in 3" :key="n" class="card skeleton-card">
        <span class="skeleton" style="width: 45%; height: 1.1em" />
        <span class="skeleton" style="width: 70%; height: 0.85em" />
        <span class="skeleton" style="width: 30%; height: 0.85em" />
      </div>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="card">
      <div class="empty">
        <span class="empty-icon"><AppIcon name="alert" :size="20" /></span>
        <span class="empty-title">{{ $t("projects.list.loadFailed") }}</span>
        <p class="small">{{ $t("projects.list.loadFailedHint") }}</p>
        <button class="secondary" @click="refresh()">
          <AppIcon name="refresh" :size="15" />
          {{ $t("common.retry") }}
        </button>
      </div>
    </div>

    <!-- Empty -->
    <div v-else-if="!projects?.length" class="card">
      <div class="empty">
        <span class="empty-icon"><AppIcon name="box" :size="20" /></span>
        <span class="empty-title">{{ $t("projects.list.emptyTitle") }}</span>
        <p v-if="isAdmin" class="small">{{ $t("projects.list.emptyHint") }}</p>
        <button v-if="isAdmin" class="primary" @click="openCreate">
          <AppIcon name="plus" :size="15" />
          {{ $t("projects.list.createButton") }}
        </button>
      </div>
    </div>

    <!-- ค้นหาแล้วไม่เจอ -->
    <div v-else-if="!filtered.length" class="card">
      <div class="empty">
        <span class="empty-icon"><AppIcon name="search" :size="20" /></span>
        <span class="empty-title">{{ $t("projects.list.noMatch", { query }) }}</span>
        <button class="secondary" @click="query = ''">
          {{ $t("projects.list.clearSearch") }}
        </button>
      </div>
    </div>

    <!-- Project grid -->
    <ul v-else class="grid">
      <li v-for="project in filtered" :key="project.id">
        <NuxtLink :to="`/projects/${project.id}`" class="card card-link project">
          <div class="project-head">
            <h3 class="truncate">{{ project.name }}</h3>
            <!-- deployment ที่กำลังทำงานสำคัญกว่าสถานะแอป ณ ตอนนั้น — แสดงแทนชั่วคราว -->
            <span
              v-if="project.activeDeployment"
              class="status status-deploying"
              :title="$t('projects.list.inProgressTitle', { status: project.activeDeployment.status })"
            >
              {{ deploymentStatusLabel(project.activeDeployment.status) }}
            </span>
            <span
              v-else
              class="status"
              :class="`status-${project.degraded ? 'degraded' : project.status}`"
            >
              {{
                project.degraded ? $t("projects.status.degraded") : projectStatusLabel(project.status)
              }}
            </span>
          </div>

          <div class="project-meta">
            <span v-if="project.repoFullName" class="meta truncate">
              <AppIcon name="github" :size="13" />
              <span class="truncate">{{ project.repoFullName }}</span>
            </span>
            <span v-else-if="project.sourceType === 'dockerfile'" class="meta truncate">
              <AppIcon name="box" :size="13" />
              {{ $t("projects.dockerfilePasted") }}
            </span>
            <span v-else class="meta unlinked">
              <AppIcon name="alert" :size="13" />
              {{ $t("projects.list.repoNotLinked") }}
            </span>

            <span v-if="project.branch" class="meta">
              <AppIcon name="branch" :size="13" />
              {{ project.branch }}
            </span>
          </div>

          <div class="project-foot">
            <span class="badge" :class="project.autoDeploy ? 'tone-ok' : ''">
              {{ project.autoDeploy ? $t("projects.list.autoDeploy") : $t("projects.list.manual") }}
            </span>
            <span v-if="project.internalPort" class="badge mono">:{{ project.internalPort }}</span>
            <span class="spacer" />
            <span class="muted tiny" :title="fullDateTime(project.updatedAt)">
              {{ timeAgo(project.updatedAt) }}
            </span>
          </div>
        </NuxtLink>
      </li>
    </ul>
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

/* ── Summary stats ── */
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--s-3);
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: var(--s-3) var(--s-4);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-sm), var(--shadow-inset);
}
.stat.alarm {
  border-color: var(--bad-edge);
  background: linear-gradient(var(--bad-tint), var(--bad-tint)), var(--surface-1);
}
.stat-label {
  font-size: var(--t-xs);
  color: var(--text-muted);
  font-weight: 500;
}
.stat-value {
  font-size: var(--t-2xl);
  font-weight: 650;
  line-height: 1.15;
  letter-spacing: -0.02em;
  display: flex;
  align-items: center;
  min-height: 1.15em;
}
.stat-skeleton {
  width: 1.2em;
  height: 0.75em;
}
.tone-ok-text {
  color: var(--ok);
}
.tone-info-text {
  color: var(--info);
}
.tone-bad-text {
  color: var(--bad);
}

/* ── Create ── */
.create {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
}
.create label {
  margin: 0;
}
.create .alert {
  margin: 0;
}

/* ── Search ── */
.search {
  position: relative;
  display: flex;
  align-items: center;
}
.search :deep(.icon) {
  position: absolute;
  left: 0.65rem;
  color: var(--text-muted);
  pointer-events: none;
}
.search input {
  padding-left: 2.1rem;
}

/* ── Grid ── */
.grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--s-3);
}

.project {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding: var(--s-4);
  height: 100%;
}
.project-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
}
.project-head h3 {
  font-size: var(--t-md);
  min-width: 0;
}

.project-meta {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}
.meta {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: var(--t-sm);
  color: var(--text-muted);
  min-width: 0;
}
.meta.unlinked {
  color: var(--warn);
}

.project-foot {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  margin-top: auto;
  padding-top: var(--s-2);
  border-top: 1px solid var(--border-subtle);
}

.skeleton-card {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding: var(--s-4);
}

@media (max-width: 720px) {
  .stats {
    grid-template-columns: repeat(2, 1fr);
  }
  .page-head .actions {
    width: 100%;
  }
  .page-head .actions .primary {
    flex: 1;
  }
}
</style>
