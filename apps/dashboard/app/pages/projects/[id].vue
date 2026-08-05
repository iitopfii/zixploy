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

/** Tab แต่ละอันเปิดจริงในเฟสที่ระบุ — ตอนนี้แสดงเป็น placeholder ที่บอกสถานะชัดเจน */
const tabs = [
  { key: "overview", label: "Overview", phase: null },
  { key: "source", label: "Source", phase: null },
  { key: "settings", label: "Settings", phase: null },
  { key: "deploy", label: "Deploy", phase: "Phase 3" },
  { key: "environment", label: "Environment", phase: "Phase 4" },
  { key: "domains", label: "Domains", phase: "Phase 5" },
  { key: "logs", label: "Logs", phase: "Phase 6" },
  { key: "volumes", label: "Volumes", phase: "Phase 7" },
] as const;

const activeTab = ref<(typeof tabs)[number]["key"]>("overview");
const activePhase = computed(() => tabs.find((t) => t.key === activeTab.value)?.phase ?? null);

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

const { data: installationsData, refresh: refreshInstallations } = await useAsyncData(
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
  if (!project.value?.installationId) return null;
  return installationsData.value?.items.find((i) => i.id === project.value!.installationId) ?? null;
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
  if (!project.value?.installationId) return "none";
  const inst = installationsData.value?.items.find((i) => i.id === project.value!.installationId);
  return inst?.status ?? "unknown";
});
</script>

<template>
  <section>
    <p v-if="initialLoading" class="muted">กำลังโหลด…</p>

    <div v-else-if="error || !project" class="card">
      <p class="error-text">ไม่พบ project นี้</p>
      <NuxtLink to="/">กลับไปหน้า Projects</NuxtLink>
    </div>

    <template v-else>
      <div class="head">
        <div>
          <NuxtLink to="/" class="muted small">← Projects</NuxtLink>
          <h1>{{ project.name }}</h1>
        </div>
        <span class="status" :class="`status-${project.status}`">{{ project.status }}</span>
      </div>

      <p v-if="project.archivedAt" class="card archived">
        project นี้ถูก archive แล้ว — แก้ไขไม่ได้
      </p>

      <nav class="tabs">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          :class="{ active: activeTab === tab.key }"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
        </button>
      </nav>

      <div class="card panel">
        <!-- Overview tab -->
        <template v-if="activeTab === 'overview'">
          <dl>
            <dt>Repository</dt>
            <dd>{{ project.repoFullName ?? "—" }}</dd>
            <dt>Branch</dt>
            <dd>{{ project.branch ?? "—" }}</dd>
            <dt>Auto deploy</dt>
            <dd>{{ project.autoDeploy ? "เปิด" : "ปิด" }}</dd>
            <dt>Dockerfile</dt>
            <dd>{{ project.dockerfilePath }}</dd>
            <dt>Build context</dt>
            <dd>{{ project.buildContext }}</dd>
            <dt>Internal port</dt>
            <dd>{{ project.internalPort ?? "—" }}</dd>
          </dl>

          <div v-if="!project.archivedAt" class="danger-zone">
            <button class="danger" @click="confirmArchive = true">Archive project</button>
          </div>
        </template>

        <!-- Source tab -->
        <template v-else-if="activeTab === 'source'">
          <div class="source-panel">
            <h2 class="section-title">GitHub Repository</h2>

            <!-- revoked warning -->
            <div
              v-if="isConnected && (installationStatus === 'deleted' || installationStatus === 'suspended')"
              class="revoke-warning"
            >
              <p class="warn-text">
                ⚠️ GitHub installation
                {{ installationStatus === 'deleted' ? 'ถูกถอนการติดตั้งแล้ว' : 'ถูก suspend' }}
                — Auto deploy ถูกปิดอัตโนมัติ
              </p>
              <p class="muted">
                {{ installationStatus === 'deleted'
                  ? 'Reinstall GitHub App แล้วเชื่อมต่อ repository ใหม่'
                  : 'Unsuspend GitHub App ผ่าน GitHub Settings แล้ว refresh' }}
              </p>
            </div>

            <!-- Connected state -->
            <template v-if="isConnected && !showPicker">
              <div class="connected-repo">
                <div class="repo-info-row">
                  <span class="label muted">Repository</span>
                  <strong>{{ project.repoFullName }}</strong>
                </div>
                <div class="repo-info-row">
                  <span class="label muted">Branch</span>
                  <code>{{ project.branch }}</code>
                </div>
                <div v-if="connectedInstallation" class="repo-info-row">
                  <span class="label muted">Account</span>
                  <span>{{ connectedInstallation.accountLogin }}</span>
                </div>
              </div>

              <p v-if="sourceSuccess" class="ok-text">เชื่อมต่อสำเร็จ</p>
              <p v-if="sourceError" class="error-text">{{ sourceError }}</p>

              <div v-if="!project.archivedAt" class="source-actions">
                <button
                  class="secondary"
                  :disabled="sourceSaving"
                  @click="showPicker = true; sourceSuccess = false"
                >
                  เปลี่ยน repository
                </button>
                <button
                  class="danger"
                  :disabled="sourceSaving"
                  @click="disconnectSource"
                >
                  {{ sourceSaving ? "กำลังยกเลิก…" : "ยกเลิกการเชื่อมต่อ" }}
                </button>
              </div>
            </template>

            <!-- Not connected / picker open -->
            <template v-else>
              <p v-if="!isConnected && !showPicker" class="muted">
                ยังไม่ได้เชื่อมต่อ repository — เลือก repository จาก GitHub
              </p>

              <!-- GitHub not configured -->
              <template v-if="statusPending">
                <p class="muted">กำลังตรวจ GitHub integration…</p>
              </template>
              <template v-else-if="!gitHubStatus?.configured">
                <div class="not-configured-msg">
                  <p class="muted">
                    GitHub App ยังไม่ได้ configure — ติดต่อผู้ดูแลระบบเพื่อตั้งค่า ZIXPLOY_GITHUB_* environment variables
                  </p>
                </div>
              </template>

              <!-- No installations -->
              <template v-else-if="activeInstallations.length === 0 && !showPicker">
                <div class="no-install">
                  <p class="muted">ยังไม่มี GitHub installation</p>
                  <GitHubConnect />
                </div>
              </template>

              <!-- Repo picker -->
              <template v-else>
                <template v-if="!showPicker && !isConnected">
                  <button
                    v-if="!project.archivedAt"
                    class="primary"
                    @click="showPicker = true"
                  >
                    เลือก repository
                  </button>
                </template>

                <template v-if="showPicker">
                  <RepositoryPicker
                    :installations="activeInstallations"
                    @pick="connectSource"
                  />

                  <div class="picker-cancel">
                    <button
                      class="secondary small"
                      :disabled="sourceSaving"
                      @click="showPicker = false; sourceError = ''"
                    >
                      ยกเลิก
                    </button>
                  </div>
                  <p v-if="sourceError" class="error-text">{{ sourceError }}</p>
                  <p v-if="sourceSaving" class="muted">กำลังบันทึก…</p>
                </template>
              </template>
            </template>
          </div>
        </template>

        <!-- Settings tab -->
        <ProjectSettingsForm
          v-else-if="activeTab === 'settings'"
          :project="project"
          @saved="refresh()"
        />

        <p v-else class="muted placeholder">
          {{ activePhase }} จะเปิดใช้งานส่วนนี้
        </p>
      </div>

      <ConfirmDialog
        :open="confirmArchive"
        title="Archive project"
        :message="`project จะถูกซ่อนจากรายการแต่ประวัติยังอยู่ ไม่ลบ volume หรือข้อมูลใด ๆ`"
        confirm-label="Archive"
        :require-typed="project.name"
        :busy="archiving"
        @cancel="confirmArchive = false"
        @confirm="archive"
      />
    </template>
  </section>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.5rem;
}
h1 {
  margin: 0.35rem 0 0;
  font-size: 1.25rem;
}
.small {
  font-size: 0.875rem;
}
.archived {
  border-color: var(--warn);
  color: var(--warn);
  margin-bottom: 1rem;
}
.tabs {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: -1px;
}
.tabs button {
  border-radius: var(--radius) var(--radius) 0 0;
  border-bottom-color: transparent;
}
.tabs button.active {
  background: var(--surface);
  border-color: var(--border);
  border-bottom-color: var(--surface);
  color: var(--accent);
}
.panel {
  border-top-left-radius: 0;
}
dl {
  display: grid;
  grid-template-columns: minmax(140px, auto) 1fr;
  gap: 0.6rem 1.5rem;
  margin: 0;
}
dt {
  color: var(--muted);
  font-size: 0.875rem;
}
dd {
  margin: 0;
}
.danger-zone {
  margin-top: 2rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--border);
}
.placeholder {
  text-align: center;
  padding: 2.5rem 1rem;
  margin: 0;
}

/* Source tab */
.source-panel {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.section-title {
  margin: 0 0 0.25rem;
  font-size: 1rem;
  font-weight: 600;
}
.revoke-warning {
  padding: 0.75rem 1rem;
  border: 1px solid var(--warn);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.warn-text {
  color: var(--warn);
  margin: 0;
}
.connected-repo {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.repo-info-row {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.label {
  min-width: 100px;
  font-size: 0.875rem;
}
.source-actions {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.not-configured-msg {
  padding: 0.75rem 1rem;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
}
.no-install {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.picker-cancel {
  margin-top: 0.5rem;
}
</style>
