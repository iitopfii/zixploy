<script setup lang="ts">
const api = useApi();

const {
  data: projects,
  pending,
  error,
  refresh,
} = await useAsyncData(
  "projects",
  async () => {
    const { data, error: apiError } = await api.api.v1.projects.get();
    if (apiError) throw new Error("โหลดรายการ project ไม่สำเร็จ");
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
      const body = apiError.value as { error?: { message?: string } } | null;
      createError.value = body?.error?.message ?? "สร้าง project ไม่สำเร็จ";
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
        <h1>Projects</h1>
        <p class="muted small">แอปพลิเคชันทั้งหมดที่ deploy ผ่าน Zixploy</p>
      </div>
      <div class="actions">
        <button class="secondary icon" title="โหลดใหม่" aria-label="โหลดใหม่" @click="refresh()">
          <AppIcon name="refresh" :size="15" />
        </button>
        <button class="primary" @click="openCreate">
          <AppIcon name="plus" :size="15" />
          สร้าง Project
        </button>
      </div>
    </header>

    <!-- Summary -->
    <div v-if="!error" class="stats">
      <div class="stat">
        <span class="stat-label">ทั้งหมด</span>
        <span class="stat-value">
          <span v-if="pending" class="skeleton stat-skeleton" />
          <template v-else>{{ stats.total }}</template>
        </span>
      </div>
      <div class="stat">
        <span class="stat-label">ทำงานอยู่</span>
        <span class="stat-value tone-ok-text">
          <span v-if="pending" class="skeleton stat-skeleton" />
          <template v-else>{{ stats.running }}</template>
        </span>
      </div>
      <div class="stat">
        <span class="stat-label">กำลัง deploy</span>
        <span class="stat-value tone-info-text">
          <span v-if="pending" class="skeleton stat-skeleton" />
          <template v-else>{{ stats.deploying }}</template>
        </span>
      </div>
      <div class="stat" :class="{ alarm: stats.attention > 0 }">
        <span class="stat-label">ต้องดูแล</span>
        <span class="stat-value" :class="stats.attention ? 'tone-bad-text' : ''">
          <span v-if="pending" class="skeleton stat-skeleton" />
          <template v-else>{{ stats.attention }}</template>
        </span>
      </div>
    </div>

    <!-- Create form -->
    <form v-if="creating" class="card create" @submit.prevent="create">
      <h2 class="section-title">สร้าง project ใหม่</h2>
      <label>
        <span>ชื่อ project</span>
        <input
          ref="nameInput"
          v-model="newName"
          placeholder="my-app"
          maxlength="100"
          :disabled="saving"
        />
        <span class="field-hint">
          เชื่อม GitHub repository และตั้งค่า build ได้หลังสร้างเสร็จ ในแท็บ Source
        </span>
      </label>
      <p v-if="createError" class="alert alert-bad">
        <AppIcon name="alert" :size="15" />
        <span>{{ createError }}</span>
      </p>
      <div class="actions-end">
        <button type="button" class="secondary" :disabled="saving" @click="creating = false">
          ยกเลิก
        </button>
        <button class="primary" type="submit" :disabled="!newName.trim() || saving">
          <span v-if="saving" class="spinner" />
          {{ saving ? "กำลังสร้าง…" : "สร้าง project" }}
        </button>
      </div>
    </form>

    <!-- Search -->
    <div v-if="!pending && !error && (projects?.length ?? 0) > 4" class="search">
      <AppIcon name="search" :size="15" />
      <input v-model="query" placeholder="ค้นหาตามชื่อหรือ repository…" />
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
        <span class="empty-title">โหลดรายการ project ไม่สำเร็จ</span>
        <p class="small">ตรวจสอบว่า control API ทำงานอยู่ แล้วลองใหม่อีกครั้ง</p>
        <button class="secondary" @click="refresh()">
          <AppIcon name="refresh" :size="15" />
          ลองใหม่
        </button>
      </div>
    </div>

    <!-- Empty -->
    <div v-else-if="!projects?.length" class="card">
      <div class="empty">
        <span class="empty-icon"><AppIcon name="box" :size="20" /></span>
        <span class="empty-title">ยังไม่มี project</span>
        <p class="small">สร้าง project แรกเพื่อเริ่ม deploy จาก GitHub repository</p>
        <button class="primary" @click="openCreate">
          <AppIcon name="plus" :size="15" />
          สร้าง Project
        </button>
      </div>
    </div>

    <!-- ค้นหาแล้วไม่เจอ -->
    <div v-else-if="!filtered.length" class="card">
      <div class="empty">
        <span class="empty-icon"><AppIcon name="search" :size="20" /></span>
        <span class="empty-title">ไม่พบ project ที่ตรงกับ "{{ query }}"</span>
        <button class="secondary" @click="query = ''">ล้างการค้นหา</button>
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
              :title="`กำลัง ${project.activeDeployment.status}`"
            >
              {{ deploymentStatusLabel(project.activeDeployment.status) }}
            </span>
            <span
              v-else
              class="status"
              :class="`status-${project.degraded ? 'degraded' : project.status}`"
            >
              {{ project.degraded ? "ผิดปกติ" : projectStatusLabel(project.status) }}
            </span>
          </div>

          <div class="project-meta">
            <span v-if="project.repoFullName" class="meta truncate">
              <AppIcon name="github" :size="13" />
              <span class="truncate">{{ project.repoFullName }}</span>
            </span>
            <span v-else-if="project.sourceType === 'dockerfile'" class="meta truncate">
              <AppIcon name="box" :size="13" />
              Dockerfile (วางเอง)
            </span>
            <span v-else class="meta unlinked">
              <AppIcon name="alert" :size="13" />
              ยังไม่ได้เชื่อม repository
            </span>

            <span v-if="project.branch" class="meta">
              <AppIcon name="branch" :size="13" />
              {{ project.branch }}
            </span>
          </div>

          <div class="project-foot">
            <span class="badge" :class="project.autoDeploy ? 'tone-ok' : ''">
              {{ project.autoDeploy ? "Auto deploy" : "Manual" }}
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
