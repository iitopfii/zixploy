<script setup lang="ts">
const api = useApi();
const route = useRoute();
const router = useRouter();
const id = computed(() => String(route.params.id));

const {
  data: project,
  pending,
  error,
  refresh,
} = await useAsyncData(
  () => `project-${id.value}`,
  async () => {
    const { data, error: apiError } = await api.api.v1.projects({ id: id.value }).get();
    if (apiError) throw new Error("not found");
    return data;
  },
  { server: false, watch: [id] },
);

/**
 * แสดง loading เฉพาะตอนโหลดครั้งแรกที่ยังไม่มีข้อมูล
 * ถ้าใช้ `pending` ตรง ๆ การ refresh หลัง save จะ unmount ทั้ง panel
 * ทำให้ฟอร์มถูกสร้างใหม่และสถานะ "บันทึกแล้ว" หายไปทันที
 */
const initialLoading = computed(() => pending.value && !project.value);

const tabs = [
  { key: "overview", label: "ภาพรวม", icon: "grid" as const },
  { key: "source", label: "Source", icon: "github" as const },
  { key: "settings", label: "ตั้งค่า", icon: "settings" as const },
  { key: "deploy", label: "Deploy", icon: "rotate" as const },
  { key: "metrics", label: "ทรัพยากร", icon: "activity" as const },
  { key: "environment", label: "Environment", icon: "key" as const },
  { key: "domains", label: "Domains", icon: "globe" as const },
  { key: "logs", label: "Logs", icon: "terminal" as const },
  { key: "volumes", label: "Volumes", icon: "database" as const },
] as const;

type TabKey = (typeof tabs)[number]["key"];

/**
 * เก็บ tab ที่เปิดอยู่ไว้ใน query string — refresh หน้าแล้วยังอยู่แท็บเดิม
 * และ copy URL ส่งต่อให้คนอื่นเปิดตรงแท็บนั้นได้
 */
const activeTab = computed<TabKey>({
  get() {
    const q = route.query.tab;
    const found = tabs.find((t) => t.key === q);
    return found?.key ?? "overview";
  },
  set(value) {
    router.replace({ query: { ...route.query, tab: value === "overview" ? undefined : value } });
  },
});

const confirmArchive = ref(false);
const archiving = ref(false);

async function archive() {
  archiving.value = true;
  try {
    await api.api.v1.projects({ id: id.value }).archive.post();
    confirmArchive.value = false;
    await router.push("/");
  } finally {
    archiving.value = false;
  }
}

// === Source tab ===
const { data: gitHubStatus, pending: statusPending } = await useAsyncData(
  "github-status-project",
  async () => {
    const { data } = await api.api.v1.github.status.get();
    return data;
  },
  { server: false },
);

const { data: installationsData } = await useAsyncData(
  "github-installations-project",
  async () => {
    const { data } = await api.api.v1.github.installations.get();
    return data;
  },
  { server: false },
);

const activeInstallations = computed(
  () => installationsData.value?.items.filter((i) => i.status === "active") ?? [],
);

const sourceError = ref("");
const sourceSaving = ref(false);
const sourceSuccess = ref(false);
const showPicker = ref(false);

/** installation ที่ project นี้เชื่อมอยู่ (ถ้ามี) */
const connectedInstallation = computed(() => {
  const installationId = project.value?.installationId;
  if (!installationId) return null;
  return installationsData.value?.items.find((i) => i.id === installationId) ?? null;
});

const isConnected = computed(() => !!project.value?.repoFullName);

async function connectSource(picked: {
  installationId: number;
  repoId: number;
  repoFullName: string;
  branch: string;
}) {
  sourceSaving.value = true;
  sourceError.value = "";
  sourceSuccess.value = false;
  try {
    const { error } = await api.api.v1.projects({ id: id.value }).source.post({
      installationId: picked.installationId,
      repoId: picked.repoId,
      repoFullName: picked.repoFullName,
      branch: picked.branch,
    });
    if (error) {
      const body = error.value as { error?: { message?: string } } | null;
      sourceError.value = body?.error?.message ?? "บันทึกไม่สำเร็จ";
      return;
    }
    sourceSuccess.value = true;
    showPicker.value = false;
    await refresh();
  } catch {
    sourceError.value = "ติดต่อ API ไม่ได้";
  } finally {
    sourceSaving.value = false;
  }
}

async function disconnectSource() {
  sourceSaving.value = true;
  sourceError.value = "";
  sourceSuccess.value = false;
  try {
    const { error } = await api.api.v1.projects({ id: id.value }).source.delete();
    if (error) {
      const body = error.value as { error?: { message?: string } } | null;
      sourceError.value = body?.error?.message ?? "ยกเลิกการเชื่อมต่อไม่สำเร็จ";
      return;
    }
    showPicker.value = false;
    await refresh();
  } catch {
    sourceError.value = "ติดต่อ API ไม่ได้";
  } finally {
    sourceSaving.value = false;
  }
}

// installation ที่ project อ้างอิง — ตรวจ revoked/suspended state
const installationStatus = computed(() => {
  const installationId = project.value?.installationId;
  if (!installationId) return "none";
  const inst = installationsData.value?.items.find((i) => i.id === installationId);
  return inst?.status ?? "unknown";
});

/** ขั้นตอนที่ยังทำไม่ครบก่อน deploy ได้ — แสดงเป็น checklist ในหน้า overview */
const setupSteps = computed(() => {
  const p = project.value;
  if (!p) return [];
  return [
    { label: "เชื่อม GitHub repository", done: !!p.repoFullName, tab: "source" as const },
    { label: "ระบุ internal port", done: p.internalPort != null, tab: "settings" as const },
  ];
});

const setupComplete = computed(() => setupSteps.value.every((s) => s.done));
</script>

<template>
  <div>
    <!-- Loading -->
    <div v-if="initialLoading" class="stack-lg">
      <span class="skeleton" style="width: 180px; height: 1.8em" />
      <span class="skeleton" style="width: 100%; height: 2.2em" />
      <div class="card">
        <span class="skeleton" style="width: 60%; height: 1em; display: block" />
      </div>
    </div>

    <!-- Not found -->
    <div v-else-if="error || !project" class="card">
      <div class="empty">
        <span class="empty-icon"><AppIcon name="alert" :size="20" /></span>
        <span class="empty-title">ไม่พบ project นี้</span>
        <p class="small">project อาจถูกลบไปแล้ว หรือลิงก์ไม่ถูกต้อง</p>
        <NuxtLink to="/" class="btn secondary">
          <AppIcon name="arrowLeft" :size="15" />
          กลับไปหน้า Projects
        </NuxtLink>
      </div>
    </div>

    <template v-else>
      <!-- ── Header ── -->
      <header class="head">
        <NuxtLink to="/" class="crumb">
          <AppIcon name="arrowLeft" :size="14" />
          Projects
        </NuxtLink>

        <div class="head-main">
          <div class="title-row">
            <h1 class="truncate">{{ project.name }}</h1>
            <span
              class="status"
              :class="`status-${project.degraded ? 'degraded' : project.status}`"
            >
              {{ project.degraded ? "ผิดปกติ" : projectStatusLabel(project.status) }}
            </span>
          </div>

          <div class="head-meta">
            <a
              v-if="project.repoFullName"
              :href="`https://github.com/${project.repoFullName}`"
              target="_blank"
              rel="noopener noreferrer"
              class="meta-link"
            >
              <AppIcon name="github" :size="13" />
              {{ project.repoFullName }}
              <AppIcon name="external" :size="11" />
            </a>
            <span v-if="project.branch" class="meta">
              <AppIcon name="branch" :size="13" />
              {{ project.branch }}
            </span>
            <span class="meta mono tiny" :title="`Project ID: ${project.id}`">
              {{ project.id }}
            </span>
          </div>
        </div>
      </header>

      <!-- Banner: archived / degraded -->
      <div v-if="project.archivedAt" class="alert alert-warn banner">
        <AppIcon name="info" :size="16" />
        <span>project นี้ถูก archive แล้ว — แก้ไขและ deploy ไม่ได้ แต่ประวัติทั้งหมดยังอยู่</span>
      </div>
      <div v-else-if="project.degraded" class="alert alert-bad banner">
        <AppIcon name="alert" :size="16" />
        <span>
          container ที่ควรทำงานอยู่หายไปจาก Docker — สั่ง deploy ใหม่เพื่อกู้คืนบริการ
        </span>
      </div>

      <!-- ── Tabs ── -->
      <nav class="tabs" aria-label="ส่วนของ project">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="tab"
          :class="{ active: activeTab === tab.key }"
          :aria-current="activeTab === tab.key ? 'page' : undefined"
          @click="activeTab = tab.key"
        >
          <AppIcon :name="tab.icon" :size="15" />
          <span>{{ tab.label }}</span>
        </button>
      </nav>

      <!-- ── Panels ── -->
      <div class="panel-wrap">
        <!-- Overview -->
        <template v-if="activeTab === 'overview'">
          <!-- checklist ก่อนพร้อม deploy — ซ่อนเมื่อครบแล้ว -->
          <div v-if="!setupComplete && !project.archivedAt" class="card setup">
            <h2 class="section-title">เตรียมพร้อมก่อน deploy</h2>
            <ul class="steps">
              <li v-for="step in setupSteps" :key="step.label" :class="{ done: step.done }">
                <span class="step-mark">
                  <AppIcon v-if="step.done" name="check" :size="12" />
                </span>
                <span class="step-label">{{ step.label }}</span>
                <button v-if="!step.done" class="ghost small" @click="activeTab = step.tab">
                  ไปตั้งค่า
                  <AppIcon name="chevronRight" :size="13" />
                </button>
              </li>
            </ul>
          </div>

          <div class="overview-grid">
            <section class="card">
              <h2 class="section-title">Source</h2>
              <dl class="kv">
                <dt>Repository</dt>
                <dd>
                  <a
                    v-if="project.repoFullName"
                    :href="`https://github.com/${project.repoFullName}`"
                    target="_blank"
                    rel="noopener noreferrer"
                  >{{ project.repoFullName }}</a>
                  <span v-else class="muted">ยังไม่ได้เชื่อม</span>
                </dd>
                <dt>Branch</dt>
                <dd>
                  <code v-if="project.branch">{{ project.branch }}</code>
                  <span v-else class="muted">—</span>
                </dd>
                <dt>Auto deploy</dt>
                <dd>
                  <span class="badge" :class="project.autoDeploy ? 'tone-ok' : 'tone-idle'">
                    {{ project.autoDeploy ? "เปิด" : "ปิด" }}
                  </span>
                </dd>
              </dl>
            </section>

            <section class="card">
              <h2 class="section-title">Build &amp; Runtime</h2>
              <dl class="kv">
                <dt>Dockerfile</dt>
                <dd><code>{{ project.dockerfilePath }}</code></dd>
                <dt>Build context</dt>
                <dd><code>{{ project.buildContext }}</code></dd>
                <dt>Internal port</dt>
                <dd>
                  <code v-if="project.internalPort">{{ project.internalPort }}</code>
                  <span v-else class="warn-text small">ยังไม่ได้ระบุ</span>
                </dd>
                <dt>Health check</dt>
                <dd>
                  <code v-if="project.healthCheckPath">{{ project.healthCheckPath }}</code>
                  <span v-else class="muted">ไม่ได้ตั้งค่า</span>
                </dd>
              </dl>
            </section>

            <section class="card">
              <h2 class="section-title">ข้อมูลทั่วไป</h2>
              <dl class="kv">
                <dt>สร้างเมื่อ</dt>
                <dd :title="fullDateTime(project.createdAt)">{{ timeAgo(project.createdAt) }}</dd>
                <dt>แก้ไขล่าสุด</dt>
                <dd :title="fullDateTime(project.updatedAt)">{{ timeAgo(project.updatedAt) }}</dd>
                <dt>Project ID</dt>
                <dd><code class="tiny">{{ project.id }}</code></dd>
              </dl>
            </section>
          </div>

          <section v-if="!project.archivedAt" class="card danger-zone">
            <div class="row-between wrap">
              <div>
                <h2 class="section-title">Archive project</h2>
                <p class="muted small">
                  ซ่อน project จากรายการ ประวัติ deployment ยังอยู่ครบ ไม่ลบ volume หรือข้อมูลใด ๆ
                </p>
              </div>
              <button class="danger" @click="confirmArchive = true">
                <AppIcon name="trash" :size="15" />
                Archive
              </button>
            </div>
          </section>
        </template>

        <!-- Source -->
        <template v-else-if="activeTab === 'source'">
          <div class="card stack">
            <h2 class="section-title">GitHub Repository</h2>

            <div
              v-if="isConnected && (installationStatus === 'deleted' || installationStatus === 'suspended')"
              class="alert alert-warn"
            >
              <AppIcon name="alert" :size="16" />
              <div class="stack-sm">
                <strong>
                  GitHub installation
                  {{ installationStatus === "deleted" ? "ถูกถอนการติดตั้งแล้ว" : "ถูก suspend" }}
                  — Auto deploy ถูกปิดอัตโนมัติ
                </strong>
                <span class="muted">
                  {{
                    installationStatus === "deleted"
                      ? "Reinstall GitHub App แล้วเชื่อมต่อ repository ใหม่"
                      : "Unsuspend GitHub App ผ่าน GitHub Settings แล้ว refresh"
                  }}
                </span>
              </div>
            </div>

            <!-- Connected -->
            <template v-if="isConnected && !showPicker">
              <div class="inset">
                <dl class="kv">
                  <dt>Repository</dt>
                  <dd>
                    <a
                      :href="`https://github.com/${project.repoFullName}`"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="repo-link"
                    >
                      {{ project.repoFullName }}
                      <AppIcon name="external" :size="12" />
                    </a>
                  </dd>
                  <dt>Branch</dt>
                  <dd><code>{{ project.branch }}</code></dd>
                  <dt v-if="connectedInstallation">Account</dt>
                  <dd v-if="connectedInstallation">{{ connectedInstallation.accountLogin }}</dd>
                </dl>
              </div>

              <p v-if="sourceSuccess" class="alert alert-ok">
                <AppIcon name="check" :size="15" />
                <span>เชื่อมต่อสำเร็จ</span>
              </p>
              <p v-if="sourceError" class="alert alert-bad">
                <AppIcon name="alert" :size="15" />
                <span>{{ sourceError }}</span>
              </p>

              <div v-if="!project.archivedAt" class="actions">
                <button
                  class="secondary"
                  :disabled="sourceSaving"
                  @click="showPicker = true; sourceSuccess = false"
                >
                  เปลี่ยน repository
                </button>
                <button class="danger" :disabled="sourceSaving" @click="disconnectSource">
                  <span v-if="sourceSaving" class="spinner" />
                  {{ sourceSaving ? "กำลังยกเลิก…" : "ยกเลิกการเชื่อมต่อ" }}
                </button>
              </div>
            </template>

            <!-- Not connected / picker -->
            <template v-else>
              <template v-if="statusPending">
                <p class="muted small">กำลังตรวจ GitHub integration…</p>
              </template>

              <template v-else-if="!gitHubStatus?.configured">
                <GitHubConnect />
              </template>

              <template v-else-if="activeInstallations.length === 0 && !showPicker">
                <div class="empty">
                  <span class="empty-icon"><AppIcon name="github" :size="20" /></span>
                  <span class="empty-title">ยังไม่มี GitHub installation</span>
                  <p class="small">ติดตั้ง GitHub App บนบัญชีของคุณก่อนเลือก repository</p>
                </div>
                <GitHubConnect />
              </template>

              <template v-else>
                <template v-if="!showPicker && !isConnected">
                  <div class="empty">
                    <span class="empty-icon"><AppIcon name="github" :size="20" /></span>
                    <span class="empty-title">ยังไม่ได้เชื่อม repository</span>
                    <p class="small">เลือก repository และ branch ที่จะใช้ deploy project นี้</p>
                    <button v-if="!project.archivedAt" class="primary" @click="showPicker = true">
                      เลือก repository
                    </button>
                  </div>
                </template>

                <template v-if="showPicker">
                  <RepositoryPicker :installations="activeInstallations" @pick="connectSource" />

                  <p v-if="sourceError" class="alert alert-bad">
                    <AppIcon name="alert" :size="15" />
                    <span>{{ sourceError }}</span>
                  </p>
                  <p v-if="sourceSaving" class="muted small">กำลังบันทึก…</p>

                  <div class="actions">
                    <button
                      class="secondary small"
                      :disabled="sourceSaving"
                      @click="showPicker = false; sourceError = ''"
                    >
                      ยกเลิก
                    </button>
                  </div>
                </template>
              </template>
            </template>
          </div>
        </template>

        <!-- Settings -->
        <div v-else-if="activeTab === 'settings'" class="card">
          <ProjectSettingsForm :project="project" @saved="refresh()" />
        </div>

        <!-- Deploy -->
        <div v-else-if="activeTab === 'deploy'" class="card">
          <DeployTab
            :project-id="id"
            :has-source="isConnected"
            :archived="!!project.archivedAt"
            :auto-deploy="project.autoDeploy"
            :branch="project.branch"
            @auto-deploy-changed="refresh()"
          />
        </div>

        <!-- Metrics -->
        <div v-else-if="activeTab === 'metrics'" class="card">
          <MetricsTab :project-id="id" />
        </div>

        <!-- Environment -->
        <div v-else-if="activeTab === 'environment'" class="card">
          <EnvironmentTab :project-id="id" :archived="!!project.archivedAt" />
        </div>

        <!-- Domains -->
        <div v-else-if="activeTab === 'domains'" class="card">
          <DomainsTab :project-id="id" :archived="!!project.archivedAt" />
        </div>

        <!-- Logs -->
        <div v-else-if="activeTab === 'logs'" class="card">
          <LogsTab :project-id="id" />
        </div>

        <!-- Volumes -->
        <div v-else-if="activeTab === 'volumes'" class="card">
          <VolumesTab :project-id="id" :archived="!!project.archivedAt" />
        </div>
      </div>

      <ConfirmDialog
        :open="confirmArchive"
        title="Archive project"
        message="project จะถูกซ่อนจากรายการแต่ประวัติยังอยู่ ไม่ลบ volume หรือข้อมูลใด ๆ"
        confirm-label="Archive"
        :require-typed="project.name"
        :busy="archiving"
        @cancel="confirmArchive = false"
        @confirm="archive"
      />
    </template>
  </div>
</template>

<style scoped>
/* ── Header ── */
.head {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  margin-bottom: var(--s-4);
}

.crumb {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: var(--t-sm);
  color: var(--text-muted);
  align-self: flex-start;
}
.crumb:hover {
  color: var(--text-secondary);
  text-decoration: none;
}

.head-main {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  min-width: 0;
}

.title-row {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  min-width: 0;
  flex-wrap: wrap;
}

.head-meta {
  display: flex;
  align-items: center;
  gap: var(--s-4);
  flex-wrap: wrap;
}
.meta,
.meta-link {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: var(--t-sm);
  color: var(--text-muted);
}
.meta-link:hover {
  color: var(--accent);
  text-decoration: none;
}
.head-meta .mono {
  color: var(--text-faint);
}

.banner {
  margin-bottom: var(--s-4);
}

/* ── Tabs ──
   segmented bar บนพื้นเข้ม — scroll แนวนอนได้บนจอแคบโดยไม่ตัดแท็บหาย */
.tabs {
  display: flex;
  gap: 2px;
  padding: 3px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r);
  overflow-x: auto;
  scrollbar-width: none;
  margin-bottom: var(--s-4);
}
.tabs::-webkit-scrollbar {
  display: none;
}

.tab {
  height: 30px;
  padding: 0 var(--s-3);
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-muted);
  font-size: var(--t-sm);
  border-radius: var(--r-sm);
}
.tab:hover:not(.active) {
  background: var(--surface-2);
  border-color: transparent;
  color: var(--text-secondary);
}
.tab.active {
  background: var(--surface-3);
  color: var(--text);
  font-weight: 550;
  box-shadow: var(--shadow-sm);
}

/* ── Panels ── */
.panel-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: var(--s-4);
}
.overview-grid .card {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
}

/* ── Setup checklist ── */
.setup {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  border-color: var(--accent-tint-strong);
  background: linear-gradient(var(--accent-tint), var(--accent-tint)), var(--surface-1);
}
.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.steps li {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  font-size: var(--t-sm);
}
.step-mark {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1.5px solid var(--border-strong);
  color: var(--accent-fg);
}
.steps li.done .step-mark {
  background: var(--ok);
  border-color: var(--ok);
  color: #05130c;
}
.steps li.done .step-label {
  color: var(--text-muted);
  text-decoration: line-through;
  text-decoration-color: var(--text-faint);
}
.step-label {
  flex: 1;
}

/* ── Danger zone ── */
.danger-zone {
  border-color: var(--bad-edge);
}
.danger-zone p {
  margin-top: 0.2rem;
  max-width: 52ch;
}

.repo-link {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}

@media (max-width: 640px) {
  .overview-grid {
    grid-template-columns: 1fr;
  }
}
</style>
