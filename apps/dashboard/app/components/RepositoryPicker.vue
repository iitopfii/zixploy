<script setup lang="ts">
/**
 * Source picker — เลือก GitHub App → repository → branch
 *
 * Steps:
 * 1. app: เลือก GitHub App และ account ที่ติดตั้ง (ข้ามอัตโนมัติถ้ามีตัวเลือกเดียว)
 * 2. repo: เลือก repository (search + pagination)
 * 3. branch: เลือก branch (search)
 */
const api = useApi();

export interface PickerInstallation {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  accountAvatarUrl: string;
  status: "active" | "suspended" | "deleted";
  appId: string | null;
  appName: string | null;
}

export interface PickedRepo {
  installationId: number;
  repoId: number;
  repoFullName: string;
  branch: string;
}

const props = defineProps<{
  installations: PickerInstallation[];
}>();

const emit = defineEmits<{
  pick: [value: PickedRepo];
}>();

/** จัดกลุ่ม installations ตาม GitHub App */
const appGroups = computed(() => {
  const groups = new Map<string, { appId: string; appName: string; items: PickerInstallation[] }>();
  for (const inst of props.installations) {
    const key = inst.appId ?? "__unlinked__";
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(inst);
    } else {
      groups.set(key, {
        appId: key,
        appName: inst.appName ?? "GitHub App (ไม่ระบุ)",
        items: [inst],
      });
    }
  }
  return Array.from(groups.values());
});

// ถ้ามีตัวเลือกเดียวให้เลือกอัตโนมัติ — ผู้ใช้ไม่ต้องคลิกเปล่า
const selectedInstallation = ref<PickerInstallation | null>(
  props.installations.length === 1 ? (props.installations[0] ?? null) : null,
);

const step = computed<"app" | "repo" | "branch">(() => {
  if (!selectedInstallation.value) return "app";
  if (!selectedRepo.value) return "repo";
  return "branch";
});

function selectInstallation(inst: PickerInstallation) {
  selectedInstallation.value = inst;
  page.value = 1;
  searchQuery.value = "";
}

function backToApps() {
  selectedInstallation.value = null;
  selectedRepo.value = null;
  selectedBranch.value = null;
}

// === Step 2: Repository ===
const searchQuery = ref("");
const page = ref(1);
const perPage = 30;

const {
  data: repoData,
  pending: repoLoading,
  error: repoError,
  refresh: refreshRepos,
} = await useAsyncData(
  () => `repos-${selectedInstallation.value?.installationId}-${page.value}`,
  async () => {
    if (!selectedInstallation.value) return null;
    const { data, error } = await api.api.v1.github
      .installations({ installationId: String(selectedInstallation.value.installationId) })
      .repositories.get({ query: { page: String(page.value), per_page: String(perPage) } });
    if (error) throw new Error("fetch repos failed");
    return data;
  },
  { server: false, watch: [selectedInstallation, page] },
);

// client-side search filter (GitHub API doesn't support server-side search for this endpoint)
const filteredRepos = computed(() => {
  const q = searchQuery.value.toLowerCase().trim();
  const repos = repoData.value?.items ?? [];
  if (!q) return repos;
  return repos.filter(
    (r) => r.fullName.toLowerCase().includes(q) || r.name.toLowerCase().includes(q),
  );
});

const totalCount = computed(() => repoData.value?.totalCount ?? 0);
const totalPages = computed(() => Math.ceil(totalCount.value / perPage));
const hasNext = computed(() => page.value < totalPages.value);
const hasPrev = computed(() => page.value > 1);

const selectedRepo = ref<(typeof filteredRepos.value)[number] | null>(null);

function pickRepo(repo: (typeof filteredRepos.value)[number]) {
  selectedRepo.value = repo;
  selectedBranch.value = null;
  searchBranch.value = "";
}

// === Step 3: Branch ===
const selectedBranch = ref<string | null>(null);
const searchBranch = ref("");

const {
  data: branchData,
  pending: branchLoading,
  error: branchError,
} = await useAsyncData(
  () => `branches-${selectedInstallation.value?.installationId}-${selectedRepo.value?.fullName}`,
  async () => {
    if (!selectedInstallation.value || !selectedRepo.value) return null;
    const { data, error } = await api.api.v1.github.branches.get({
      query: {
        installationId: String(selectedInstallation.value.installationId),
        repo: selectedRepo.value.fullName,
      },
    });
    if (error) throw new Error("fetch branches failed");
    return data;
  },
  { server: false, watch: [selectedRepo] },
);

const filteredBranches = computed(() => {
  const q = searchBranch.value.toLowerCase().trim();
  const branches = branchData.value?.items ?? [];
  if (!q) return branches;
  return branches.filter((b) => b.name.toLowerCase().includes(q));
});

function confirmPick(branch: string) {
  if (!selectedInstallation.value || !selectedRepo.value) return;
  emit("pick", {
    installationId: selectedInstallation.value.installationId,
    repoId: selectedRepo.value.id,
    repoFullName: selectedRepo.value.fullName,
    branch,
  });
}
</script>

<template>
  <div class="stack">
    <!-- Breadcrumb -->
    <div class="breadcrumb">
      <button
        class="crumb"
        :class="{ active: step === 'app' }"
        :disabled="step === 'app'"
        @click="backToApps"
      >
        1. App
      </button>
      <AppIcon name="chevronRight" :size="12" class="sep-icon" />
      <button
        class="crumb"
        :class="{ active: step === 'repo' }"
        :disabled="step !== 'branch'"
        @click="selectedRepo = null"
      >
        2. Repository
      </button>
      <AppIcon name="chevronRight" :size="12" class="sep-icon" />
      <span class="crumb" :class="{ active: step === 'branch' }">3. Branch</span>
    </div>

    <!-- Step 1: เลือก App + account -->
    <template v-if="step === 'app'">
      <p v-if="appGroups.length === 0" class="muted small">
        ยังไม่มี GitHub App ที่ติดตั้ง — สร้างและติดตั้งที่หน้า settings ก่อน
      </p>

      <div v-for="group in appGroups" :key="group.appId" class="inset app-group">
        <div class="app-group-head">
          <strong>{{ group.appName }}</strong>
          <span class="muted small">{{ group.items.length }} account</span>
        </div>
        <ul class="account-list">
          <li
            v-for="inst in group.items"
            :key="inst.id"
            class="account-item"
            :class="{ suspended: inst.status === 'suspended' }"
            @click="inst.status === 'active' && selectInstallation(inst)"
          >
            <img
              v-if="inst.accountAvatarUrl"
              :src="inst.accountAvatarUrl"
              :alt="inst.accountLogin"
              class="avatar"
              width="22"
              height="22"
            />
            <span v-else class="avatar avatar-fallback" aria-hidden="true">
              {{ inst.accountLogin.charAt(0).toUpperCase() }}
            </span>
            <span class="account-name">{{ inst.accountLogin }}</span>
            <span class="muted small">{{ inst.accountType }}</span>
            <span v-if="inst.status === 'suspended'" class="status status-mismatch">Suspended</span>
            <AppIcon v-else name="chevronRight" :size="14" class="chevron" />
          </li>
        </ul>
      </div>
    </template>

    <!-- Step 2: Repository -->
    <template v-else-if="step === 'repo'">
      <div class="selected-context">
        <button class="secondary tiny" @click="backToApps">
          <AppIcon name="arrowLeft" :size="12" />
          เปลี่ยน app
        </button>
        <span class="muted small">
          {{ selectedInstallation?.appName }} / {{ selectedInstallation?.accountLogin }}
        </span>
      </div>

      <p v-if="selectedInstallation?.status === 'suspended'" class="alert alert-warn">
        <AppIcon name="alert" :size="14" />
        <span>GitHub installation นี้ถูก suspend — unsuspend ผ่าน GitHub App settings ก่อน</span>
      </p>

      <div class="search-bar">
        <div class="search-field">
          <AppIcon name="search" :size="14" />
          <input v-model="searchQuery" type="search" placeholder="ค้นหา repository…" @input="page = 1" />
        </div>
        <button class="secondary small icon" title="รีเฟรช" aria-label="รีเฟรช" @click="() => refreshRepos()">
          <AppIcon name="refresh" :size="14" />
        </button>
      </div>

      <div v-if="repoLoading" class="stack-sm">
        <span class="skeleton" style="height: 52px" />
        <span class="skeleton" style="height: 52px" />
        <span class="skeleton" style="height: 52px" />
      </div>

      <div v-else-if="repoError" class="alert alert-bad">
        <AppIcon name="alert" :size="15" />
        <span>ไม่สามารถดึง repositories ได้</span>
        <button class="secondary tiny" @click="() => refreshRepos()">ลองใหม่</button>
      </div>

      <template v-else-if="filteredRepos.length > 0">
        <ul class="repo-list">
          <li
            v-for="repo in filteredRepos"
            :key="repo.id"
            class="repo-item"
            @click="pickRepo(repo)"
          >
            <div class="repo-info">
              <span class="repo-name">{{ repo.fullName }}</span>
              <span v-if="repo.private" class="badge tone-warn">Private</span>
            </div>
            <span v-if="repo.description" class="repo-desc muted truncate">{{ repo.description }}</span>
          </li>
        </ul>

        <!-- pagination -->
        <div v-if="totalPages > 1" class="pagination">
          <button :disabled="!hasPrev" class="secondary small" @click="page--">ก่อนหน้า</button>
          <span class="muted small">หน้า {{ page }} / {{ totalPages }}</span>
          <button :disabled="!hasNext" class="secondary small" @click="page++">ถัดไป</button>
        </div>
      </template>

      <p v-else-if="searchQuery" class="muted small">ไม่พบ repository ที่ตรงกับ "{{ searchQuery }}"</p>
      <p v-else class="muted small">ไม่มี repository ที่เข้าถึงได้ — ตรวจสอบ GitHub App permissions</p>
    </template>

    <!-- Step 3: Branch -->
    <template v-else>
      <div class="selected-context">
        <button class="secondary tiny" @click="selectedRepo = null">
          <AppIcon name="arrowLeft" :size="12" />
          เปลี่ยน repository
        </button>
        <strong>{{ selectedRepo?.fullName }}</strong>
        <span v-if="selectedRepo?.private" class="badge tone-warn">Private</span>
      </div>

      <div class="search-bar">
        <div class="search-field">
          <AppIcon name="search" :size="14" />
          <input v-model="searchBranch" type="search" placeholder="ค้นหา branch…" />
        </div>
      </div>

      <div v-if="branchLoading" class="stack-sm">
        <span class="skeleton" style="height: 42px" />
        <span class="skeleton" style="height: 42px" />
      </div>

      <div v-else-if="branchError" class="alert alert-bad">
        <AppIcon name="alert" :size="15" />
        <span>ไม่สามารถดึง branches ได้</span>
      </div>

      <template v-else-if="filteredBranches.length > 0">
        <ul class="branch-list">
          <li
            v-for="branch in filteredBranches"
            :key="branch.name"
            class="branch-item"
            :class="{ selected: selectedBranch === branch.name }"
            @click="selectedBranch = branch.name"
          >
            <span class="branch-name mono">{{ branch.name }}</span>
            <span v-if="branch.protected" class="badge tone-info">Protected</span>
            <span v-if="branch.name === selectedRepo?.defaultBranch" class="badge tone-ok">
              Default
            </span>
          </li>
        </ul>

        <div class="branch-actions">
          <button
            class="primary"
            :disabled="!selectedBranch"
            @click="selectedBranch && confirmPick(selectedBranch)"
          >
            เลือก branch นี้
          </button>
        </div>
      </template>

      <p v-else class="muted small">ไม่พบ branch ที่ตรงกับ "{{ searchBranch }}"</p>
    </template>
  </div>
</template>

<style scoped>
.breadcrumb {
  display: flex;
  align-items: center;
  gap: var(--s-1);
}
.crumb {
  background: none;
  border: none;
  box-shadow: none;
  height: auto;
  padding: 0.15rem 0.35rem;
  color: var(--text-muted);
  font-size: var(--t-sm);
}
.crumb:hover:not(:disabled) {
  background: var(--surface-2);
  color: var(--text-secondary);
}
.crumb:disabled {
  cursor: default;
  opacity: 1;
}
.crumb.active {
  color: var(--accent);
  font-weight: 600;
}
.sep-icon {
  color: var(--text-faint);
}

.app-group {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.app-group-head {
  display: flex;
  align-items: baseline;
  gap: var(--s-3);
}

.account-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
}
.account-item {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--border);
  border-radius: var(--r);
  cursor: pointer;
  background: var(--surface-1);
  transition: background var(--fast), border-color var(--fast);
}
.account-item:hover:not(.suspended) {
  background: var(--surface-2);
  border-color: var(--border-strong);
}
.account-item.suspended {
  cursor: not-allowed;
  opacity: 0.55;
}
.account-name {
  font-weight: 500;
  font-size: var(--t-sm);
}
.chevron {
  margin-left: auto;
  color: var(--text-faint);
}

.avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.avatar-fallback {
  display: grid;
  place-items: center;
  background: var(--surface-3);
  border: 1px solid var(--border);
  font-size: 10px;
  font-weight: 600;
  color: var(--text-secondary);
}

.selected-context {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  flex-wrap: wrap;
}

.search-bar {
  display: flex;
  gap: var(--s-2);
  align-items: center;
}
.search-field {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
}
.search-field :deep(.icon) {
  position: absolute;
  left: 0.6rem;
  color: var(--text-muted);
  pointer-events: none;
}
.search-field input {
  padding-left: 2rem;
}

.repo-list,
.branch-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
  max-height: 320px;
  overflow-y: auto;
}
.repo-item,
.branch-item {
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--border);
  border-radius: var(--r);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  background: var(--surface-1);
  transition: background var(--fast), border-color var(--fast);
}
.repo-item:hover,
.branch-item:hover {
  background: var(--surface-2);
  border-color: var(--border-strong);
}
.branch-item {
  flex-direction: row;
  align-items: center;
  gap: var(--s-2);
}
.branch-item.selected {
  border-color: var(--accent);
  background: var(--accent-tint);
}
.repo-info {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}
.repo-name {
  font-weight: 500;
  font-size: var(--t-sm);
}
.repo-desc {
  font-size: var(--t-xs);
}
.branch-name {
  font-size: var(--t-sm);
}

.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--s-3);
}
.branch-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
