<script setup lang="ts">
const api = useApi();
const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const { isAdmin, canWrite } = usePermissions();
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

/** label ของแต่ละแท็บอยู่ที่ projects.tab.<key> — แปลใน template เพื่อให้เปลี่ยนตามภาษา */
const tabs = [
  { key: "overview", icon: "grid" as const },
  { key: "source", icon: "github" as const },
  { key: "settings", icon: "settings" as const },
  { key: "deploy", icon: "rotate" as const },
  { key: "metrics", icon: "activity" as const },
  { key: "environment", icon: "key" as const },
  { key: "domains", icon: "globe" as const },
  { key: "components", icon: "box" as const },
  { key: "logs", icon: "terminal" as const },
  { key: "volumes", icon: "database" as const },
] as const;

type TabKey = (typeof tabs)[number]["key"];

/**
 * เก็บ tab ที่เปิดอยู่ไว้ใน query string — refresh หน้าแล้วยังอยู่แท็บเดิม
 * และ copy URL ส่งต่อให้คนอื่นเปิดตรงแท็บนั้นได้
 */
const activeTab = computed<TabKey>({
  get() {
    const q = route.query.tab;
    const found = tabs.find((tab) => tab.key === q);
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

// Dockerfile-paste source (Phase 13) — แยก fetch เพราะเนื้อหาอาจใหญ่ ไม่รวมอยู่ใน project object ทั่วไป
const {
  data: dockerfileSource,
  pending: dockerfileSourcePending,
  refresh: refreshDockerfileSource,
} = await useAsyncData(
  () => `dockerfile-source-${id.value}`,
  async () => {
    const { data } = await api.api.v1.projects({ id: id.value }).source.dockerfile.get();
    return data;
  },
  { server: false, watch: [id] },
);

const sourceError = ref("");
const sourceSaving = ref(false);
const sourceSuccess = ref(false);
const showPicker = ref(false);
/** โหมดที่เลือกตอนยังไม่เคยตั้ง source อะไรเลย — null = ยังไม่เลือก (แสดงตัวเลือก) */
const chosenSourceMode = ref<"github" | "dockerfile" | null>(null);

async function switchToDockerfileMode() {
  chosenSourceMode.value = "dockerfile";
  showPicker.value = false;
  sourceError.value = "";
}
async function switchToGitHubMode() {
  chosenSourceMode.value = "github";
  sourceError.value = "";
}
async function onDockerfileSourceSaved() {
  chosenSourceMode.value = null;
  await Promise.all([refresh(), refreshDockerfileSource()]);
}

/** โหมด source ที่ควรแสดงตอนนี้ — null = ยังไม่เชื่อมอะไรเลยและยังไม่ได้เลือก (แสดงตัวเลือก) */
const effectiveSourceMode = computed<"github" | "dockerfile" | null>(() => {
  if (isConnected.value)
    return project.value?.sourceType === "dockerfile" ? "dockerfile" : "github";
  return chosenSourceMode.value;
});

/** installation ที่ project นี้เชื่อมอยู่ (ถ้ามี) */
const connectedInstallation = computed(() => {
  const installationId = project.value?.installationId;
  if (!installationId) return null;
  return installationsData.value?.items.find((i) => i.id === installationId) ?? null;
});

/** เชื่อมต่อแล้วไม่ว่าโหมดไหน — repo (GitHub) หรือวางเนื้อหาไว้แล้ว (dockerfile) */
const isConnected = computed(() => {
  const p = project.value;
  if (!p) return false;
  if (p.sourceType === "dockerfile") return !!dockerfileSource.value?.dockerfile;
  return !!p.repoFullName;
});

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
      sourceError.value = apiErrorMessage(error, "common.saveFailed");
      return;
    }
    sourceSuccess.value = true;
    showPicker.value = false;
    chosenSourceMode.value = null;
    await Promise.all([refresh(), refreshDockerfileSource()]);
  } catch {
    sourceError.value = t("common.apiUnreachable");
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
      sourceError.value = apiErrorMessage(error, "projects.source.disconnectFailed");
      return;
    }
    showPicker.value = false;
    chosenSourceMode.value = null;
    await Promise.all([refresh(), refreshDockerfileSource()]);
  } catch {
    sourceError.value = t("common.apiUnreachable");
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
    {
      label: t("projects.overview.stepSource"),
      done: isConnected.value,
      tab: "source" as const,
    },
    {
      label: t("projects.overview.stepPort"),
      done: p.internalPort != null,
      tab: "settings" as const,
    },
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
        <span class="empty-title">{{ $t("projects.detail.notFoundTitle") }}</span>
        <p class="small">{{ $t("projects.detail.notFoundHint") }}</p>
        <NuxtLink to="/" class="btn secondary">
          <AppIcon name="arrowLeft" :size="15" />
          {{ $t("projects.detail.backToProjects") }}
        </NuxtLink>
      </div>
    </div>

    <template v-else>
      <!-- ── Header ── -->
      <header class="head">
        <NuxtLink to="/" class="crumb">
          <AppIcon name="arrowLeft" :size="14" />
          {{ $t("projects.list.title") }}
        </NuxtLink>

        <div class="head-main">
          <div class="title-row">
            <h1 class="truncate">{{ project.name }}</h1>
            <span
              class="status"
              :class="`status-${project.degraded ? 'degraded' : project.status}`"
            >
              {{
                project.degraded ? $t("projects.status.degraded") : projectStatusLabel(project.status)
              }}
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
            <span v-else-if="project.sourceType === 'dockerfile' && isConnected" class="meta">
              <AppIcon name="box" :size="13" />
              {{ $t("projects.dockerfilePasted") }}
            </span>
            <span v-if="project.branch" class="meta">
              <AppIcon name="branch" :size="13" />
              {{ project.branch }}
            </span>
            <span class="meta mono tiny" :title="$t('projects.detail.projectIdTitle', { id: project.id })">
              {{ project.id }}
            </span>
          </div>
        </div>
      </header>

      <!-- viewer ดูได้อย่างเดียว — บอกครั้งเดียวที่หัวหน้า แทนการอธิบายทุกปุ่มที่ถูกซ่อน -->
      <p v-if="!canWrite" class="alert alert-info banner">
        <AppIcon name="info" :size="16" />
        <span>{{ $t("common.readOnly") }}</span>
      </p>

      <!-- Banner: archived / degraded -->
      <div v-if="project.archivedAt" class="alert alert-warn banner">
        <AppIcon name="info" :size="16" />
        <span>{{ $t("projects.detail.archivedBanner") }}</span>
      </div>
      <div v-else-if="project.degraded" class="alert alert-bad banner">
        <AppIcon name="alert" :size="16" />
        <span>{{ $t("projects.detail.degradedBanner") }}</span>
      </div>

      <!-- ── Tabs ── -->
      <nav class="tabs" :aria-label="$t('projects.detail.tabsLabel')">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="tab"
          :class="{ active: activeTab === tab.key }"
          :aria-current="activeTab === tab.key ? 'page' : undefined"
          @click="activeTab = tab.key"
        >
          <AppIcon :name="tab.icon" :size="15" />
          <span>{{ $t(`projects.tab.${tab.key}`) }}</span>
        </button>
      </nav>

      <!-- ── Panels ── -->
      <div class="panel-wrap">
        <!-- Overview -->
        <template v-if="activeTab === 'overview'">
          <!-- checklist ก่อนพร้อม deploy — ซ่อนเมื่อครบแล้ว -->
          <div v-if="!setupComplete && !project.archivedAt" class="card setup">
            <h2 class="section-title">{{ $t("projects.overview.setupTitle") }}</h2>
            <ul class="steps">
              <li v-for="step in setupSteps" :key="step.tab" :class="{ done: step.done }">
                <span class="step-mark">
                  <AppIcon v-if="step.done" name="check" :size="12" />
                </span>
                <span class="step-label">{{ step.label }}</span>
                <button v-if="!step.done" class="ghost small" @click="activeTab = step.tab">
                  {{ $t("projects.overview.goSetup") }}
                  <AppIcon name="chevronRight" :size="13" />
                </button>
              </li>
            </ul>
          </div>

          <div class="overview-grid">
            <section class="card">
              <h2 class="section-title">{{ $t("projects.tab.source") }}</h2>
              <dl class="kv">
                <template v-if="project.sourceType === 'dockerfile'">
                  <dt>{{ $t("projects.overview.type") }}</dt>
                  <dd>
                    <span v-if="isConnected" class="badge tone-ok">
                      {{ $t("projects.dockerfilePasted") }}
                    </span>
                    <span v-else class="muted">{{ $t("projects.overview.notConfigured") }}</span>
                  </dd>
                </template>
                <template v-else>
                  <dt>Repository</dt>
                  <dd>
                    <a
                      v-if="project.repoFullName"
                      :href="`https://github.com/${project.repoFullName}`"
                      target="_blank"
                      rel="noopener noreferrer"
                    >{{ project.repoFullName }}</a>
                    <span v-else class="muted">{{ $t("projects.overview.notLinked") }}</span>
                  </dd>
                  <dt>Branch</dt>
                  <dd>
                    <code v-if="project.branch">{{ project.branch }}</code>
                    <span v-else class="muted">—</span>
                  </dd>
                </template>
                <dt>Auto deploy</dt>
                <dd>
                  <span class="badge" :class="project.autoDeploy ? 'tone-ok' : 'tone-idle'">
                    {{ project.autoDeploy ? $t("common.enabled") : $t("common.disabled") }}
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
                  <span v-else class="warn-text small">{{ $t("projects.overview.portMissing") }}</span>
                </dd>
                <dt>Health check</dt>
                <dd>
                  <code v-if="project.healthCheckPath">{{ project.healthCheckPath }}</code>
                  <span v-else class="muted">{{ $t("projects.overview.healthCheckNone") }}</span>
                </dd>
              </dl>
            </section>

            <section class="card">
              <h2 class="section-title">{{ $t("projects.overview.general") }}</h2>
              <dl class="kv">
                <dt>{{ $t("projects.overview.createdAt") }}</dt>
                <dd :title="fullDateTime(project.createdAt)">{{ timeAgo(project.createdAt) }}</dd>
                <dt>{{ $t("projects.overview.updatedAt") }}</dt>
                <dd :title="fullDateTime(project.updatedAt)">{{ timeAgo(project.updatedAt) }}</dd>
                <dt>Project ID</dt>
                <dd><code class="tiny">{{ project.id }}</code></dd>
              </dl>
            </section>
          </div>

          <section v-if="!project.archivedAt && isAdmin" class="card danger-zone">
            <div class="row-between wrap">
              <div>
                <h2 class="section-title">{{ $t("projects.overview.archiveTitle") }}</h2>
                <p class="muted small">
                  {{ $t("projects.overview.archiveHint") }}
                </p>
              </div>
              <button class="danger" @click="confirmArchive = true">
                <AppIcon name="trash" :size="15" />
                {{ $t("projects.overview.archiveButton") }}
              </button>
            </div>
          </section>
        </template>

        <!-- Source -->
        <template v-else-if="activeTab === 'source'">
          <div class="card stack">
            <h2 class="section-title">{{ $t("projects.tab.source") }}</h2>

            <!-- ยังไม่เชื่อมอะไรเลยและยังไม่ได้เลือกโหมด — ให้เลือกก่อน -->
            <template v-if="!effectiveSourceMode">
              <p v-if="!canWrite" class="muted small">
                {{ $t("projects.overview.notConfigured") }}
              </p>
              <p v-if="canWrite" class="muted small">{{ $t("projects.source.chooseMode") }}</p>
              <div v-if="canWrite" class="mode-picker">
                <button
                  class="mode-card"
                  :disabled="!!project.archivedAt"
                  @click="chosenSourceMode = 'github'"
                >
                  <AppIcon name="github" :size="22" />
                  <strong>{{ $t("projects.source.modeGithub") }}</strong>
                  <span class="muted small">{{ $t("projects.source.modeGithubHint") }}</span>
                </button>
                <button
                  class="mode-card"
                  :disabled="!!project.archivedAt"
                  @click="switchToDockerfileMode"
                >
                  <AppIcon name="box" :size="22" />
                  <strong>{{ $t("projects.source.modeDockerfile") }}</strong>
                  <span class="muted small">{{ $t("projects.source.modeDockerfileHint") }}</span>
                </button>
              </div>
            </template>

            <!-- Dockerfile-paste mode -->
            <template v-else-if="effectiveSourceMode === 'dockerfile'">
              <p v-if="dockerfileSourcePending" class="muted small">{{ $t("common.loading") }}</p>
              <template v-else>
                <DockerfileSource
                  :project-id="id"
                  :initial-content="dockerfileSource?.dockerfile ?? null"
                  :archived="!!project.archivedAt"
                  @saved="onDockerfileSourceSaved"
                />
                <div v-if="!project.archivedAt && canWrite" class="actions">
                  <button
                    v-if="isConnected"
                    class="secondary small"
                    :disabled="sourceSaving"
                    @click="switchToGitHubMode"
                  >
                    {{ $t("projects.source.switchToGithub") }}
                  </button>
                  <button
                    v-else
                    class="secondary small"
                    :disabled="sourceSaving"
                    @click="chosenSourceMode = null"
                  >
                    <AppIcon name="arrowLeft" :size="13" />
                    {{ $t("projects.source.backToModes") }}
                  </button>
                </div>
              </template>
            </template>

            <!-- GitHub mode -->
            <template v-else>
              <div
                v-if="isConnected && (installationStatus === 'deleted' || installationStatus === 'suspended')"
                class="alert alert-warn"
              >
                <AppIcon name="alert" :size="16" />
                <div class="stack-sm">
                  <strong>
                    {{
                      installationStatus === "deleted"
                        ? $t("projects.source.installDeletedTitle")
                        : $t("projects.source.installSuspendedTitle")
                    }}
                  </strong>
                  <span class="muted">
                    {{
                      installationStatus === "deleted"
                        ? $t("projects.source.installDeletedHint")
                        : $t("projects.source.installSuspendedHint")
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
                    <dt v-if="connectedInstallation">{{ $t("projects.source.account") }}</dt>
                    <dd v-if="connectedInstallation">{{ connectedInstallation.accountLogin }}</dd>
                  </dl>
                </div>

                <p v-if="sourceSuccess" class="alert alert-ok">
                  <AppIcon name="check" :size="15" />
                  <span>{{ $t("projects.source.connected") }}</span>
                </p>
                <p v-if="sourceError" class="alert alert-bad">
                  <AppIcon name="alert" :size="15" />
                  <span>{{ sourceError }}</span>
                </p>

                <div v-if="!project.archivedAt && canWrite" class="actions">
                  <button
                    class="secondary"
                    :disabled="sourceSaving"
                    @click="showPicker = true; sourceSuccess = false"
                  >
                    {{ $t("projects.source.changeRepo") }}
                  </button>
                  <button class="danger" :disabled="sourceSaving" @click="disconnectSource">
                    <span v-if="sourceSaving" class="spinner" />
                    {{
                      sourceSaving
                        ? $t("projects.source.disconnecting")
                        : $t("projects.source.disconnect")
                    }}
                  </button>
                </div>
              </template>

              <!-- Not connected / picker -->
              <template v-else>
                <template v-if="statusPending">
                  <p class="muted small">{{ $t("projects.source.checkingGithub") }}</p>
                </template>

                <template v-else-if="!gitHubStatus?.configured">
                  <GitHubConnect />
                </template>

                <template v-else-if="activeInstallations.length === 0 && !showPicker">
                  <div class="empty">
                    <span class="empty-icon"><AppIcon name="github" :size="20" /></span>
                    <span class="empty-title">{{ $t("projects.source.noInstallationTitle") }}</span>
                    <p class="small">{{ $t("projects.source.noInstallationHint") }}</p>
                  </div>
                  <GitHubConnect />
                </template>

                <template v-else>
                  <template v-if="!showPicker && !isConnected">
                    <div class="empty">
                      <span class="empty-icon"><AppIcon name="github" :size="20" /></span>
                      <span class="empty-title">{{ $t("projects.source.notLinkedTitle") }}</span>
                      <p v-if="canWrite" class="small">{{ $t("projects.source.notLinkedHint") }}</p>
                      <button
                        v-if="!project.archivedAt && canWrite"
                        class="primary"
                        @click="showPicker = true"
                      >
                        {{ $t("projects.source.pickRepo") }}
                      </button>
                    </div>
                  </template>

                  <template v-if="showPicker && canWrite">
                    <RepositoryPicker :installations="activeInstallations" @pick="connectSource" />

                    <p v-if="sourceError" class="alert alert-bad">
                      <AppIcon name="alert" :size="15" />
                      <span>{{ sourceError }}</span>
                    </p>
                    <p v-if="sourceSaving" class="muted small">{{ $t("common.saving") }}</p>

                    <div class="actions">
                      <button
                        class="secondary small"
                        :disabled="sourceSaving"
                        @click="showPicker = false; sourceError = ''"
                      >
                        {{ $t("common.cancel") }}
                      </button>
                    </div>
                  </template>

                  <div
                    v-if="!showPicker && !isConnected && !project.archivedAt && canWrite"
                    class="actions"
                  >
                    <button class="secondary small" @click="chosenSourceMode = null">
                      <AppIcon name="arrowLeft" :size="13" />
                      {{ $t("projects.source.backToModes") }}
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
            :source-type="project.sourceType"
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
          <DomainsTab :project-id="id" :archived="!!project.archivedAt" :mode="project.mode" />
        </div>

        <!-- Components -->
        <div v-else-if="activeTab === 'components'" class="card">
          <ComponentsTab
            :project-id="id"
            :archived="!!project.archivedAt"
            :mode="project.mode"
            :installations="activeInstallations"
            @changed="refresh()"
          />
        </div>

        <!-- Logs -->
        <div v-else-if="activeTab === 'logs'" class="card">
          <LogsTab :project-id="id" />
        </div>

        <!-- Volumes -->
        <div v-else-if="activeTab === 'volumes'" class="card">
          <VolumesTab :project-id="id" :archived="!!project.archivedAt" :mode="project.mode" />
        </div>
      </div>

      <ConfirmDialog
        :open="confirmArchive"
        :title="$t('projects.overview.archiveTitle')"
        :message="$t('projects.overview.archiveConfirm')"
        :confirm-label="$t('projects.overview.archiveButton')"
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

/* ── Source mode picker ── */
.mode-picker {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--s-3);
}
.mode-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--s-2);
  padding: var(--s-4);
  text-align: left;
  background: var(--surface-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r);
  transition:
    border-color var(--fast),
    background var(--fast);
}
.mode-card:hover:not(:disabled) {
  background: var(--surface-3);
  border-color: var(--accent-tint-strong);
}
.mode-card strong {
  font-size: var(--t-sm);
}

@media (max-width: 640px) {
  .overview-grid {
    grid-template-columns: 1fr;
  }
}
</style>
