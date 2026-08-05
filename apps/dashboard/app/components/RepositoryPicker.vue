<script setup lang="ts">
/**
 * Repository picker — เลือก repository จาก GitHub installation
 *
 * States:
 * - ยังไม่มี installation: แสดง GitHubConnect
 * - loading: กำลังดึง repos
 * - empty: ไม่มี repo ที่เข้าถึงได้
 * - error: GitHub API error
 * - success: แสดงรายการ repos พร้อม search + pagination
 */
const api = useApi();

export interface PickerInstallation {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  accountAvatarUrl: string;
  status: "active" | "suspended" | "deleted";
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

const selectedInstallation = ref<PickerInstallation | null>(props.installations[0] ?? null);
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

function selectInstallation(install: PickerInstallation) {
  selectedInstallation.value = install;
  page.value = 1;
  searchQuery.value = "";
}

// Selected repo (step 1)
const selectedRepo = ref<(typeof filteredRepos.value)[number] | null>(null);

function pickRepo(repo: (typeof filteredRepos.value)[number]) {
  selectedRepo.value = repo;
  selectedBranch.value = null;
  searchBranch.value = "";
}

// Branch picker (step 2)
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
  <div class="repo-picker">
    <!-- Installation selector (ถ้ามีหลาย installation) -->
    <div v-if="installations.length > 1" class="install-selector">
      <button
        v-for="install in installations"
        :key="install.id"
        :class="{ active: selectedInstallation?.id === install.id }"
        class="install-btn"
        @click="selectInstallation(install)"
      >
        {{ install.accountLogin }}
      </button>
    </div>

    <!-- Revoked installation warning -->
    <p
      v-if="selectedInstallation?.status === 'suspended'"
      class="warn-text"
    >
      ⚠️ GitHub installation นี้ถูก suspend — unsuspend ผ่าน GitHub App settings ก่อน
    </p>

    <!-- Step 1: Repository list -->
    <template v-if="!selectedRepo">
      <div class="search-bar">
        <input
          v-model="searchQuery"
          type="search"
          placeholder="ค้นหา repository…"
          class="search-input"
          @input="page = 1"
        />
        <button class="secondary small" @click="() => refreshRepos()">รีเฟรช</button>
      </div>

      <p v-if="repoLoading" class="muted">กำลังโหลด repositories…</p>

      <div v-else-if="repoError" class="error-state">
        <p class="error-text">ไม่สามารถดึง repositories ได้</p>
        <button class="secondary small" @click="() => refreshRepos()">ลองใหม่</button>
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
              <span v-if="repo.private" class="badge private">Private</span>
            </div>
            <span v-if="repo.description" class="repo-desc muted">{{ repo.description }}</span>
          </li>
        </ul>

        <!-- pagination -->
        <div v-if="totalPages > 1" class="pagination">
          <button :disabled="!hasPrev" class="secondary small" @click="page--">← ก่อนหน้า</button>
          <span class="muted small">หน้า {{ page }} / {{ totalPages }}</span>
          <button :disabled="!hasNext" class="secondary small" @click="page++">ถัดไป →</button>
        </div>
      </template>

      <p v-else-if="searchQuery" class="muted">ไม่พบ repository ที่ตรงกับ "{{ searchQuery }}"</p>
      <p v-else class="muted">ไม่มี repository ที่เข้าถึงได้ — ตรวจสอบ GitHub App permissions</p>
    </template>

    <!-- Step 2: Branch selection -->
    <template v-else>
      <div class="repo-selected">
        <button class="back-btn secondary small" @click="selectedRepo = null">← เปลี่ยน repository</button>
        <strong>{{ selectedRepo.fullName }}</strong>
        <span v-if="selectedRepo.private" class="badge private">Private</span>
      </div>

      <div class="search-bar">
        <input
          v-model="searchBranch"
          type="search"
          placeholder="ค้นหา branch…"
          class="search-input"
        />
      </div>

      <p v-if="branchLoading" class="muted">กำลังโหลด branches…</p>

      <div v-else-if="branchError" class="error-state">
        <p class="error-text">ไม่สามารถดึง branches ได้</p>
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
            <span class="branch-name">{{ branch.name }}</span>
            <span v-if="branch.protected" class="badge protected">Protected</span>
            <span
              v-if="branch.name === selectedRepo.defaultBranch"
              class="badge default"
            >Default</span>
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

      <p v-else class="muted">ไม่พบ branch ที่ตรงกับ "{{ searchBranch }}"</p>
    </template>
  </div>
</template>

<style scoped>
.repo-picker {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.install-selector {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.install-btn {
  font-size: 0.875rem;
  padding: 0.3rem 0.75rem;
}
.install-btn.active {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.search-bar {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.search-input {
  flex: 1;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
  font-size: 0.875rem;
}
.repo-list,
.branch-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  max-height: 320px;
  overflow-y: auto;
}
.repo-item,
.branch-item {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.repo-item:hover,
.branch-item:hover {
  background: var(--surface-alt, color-mix(in srgb, var(--surface) 80%, var(--accent)));
}
.branch-item.selected {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.repo-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.repo-name {
  font-weight: 500;
}
.repo-desc {
  font-size: 0.8125rem;
}
.branch-name {
  font-family: monospace;
}
.badge {
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: 99px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.badge.private {
  background: color-mix(in srgb, var(--warn) 15%, transparent);
  color: var(--warn);
}
.badge.protected {
  background: color-mix(in srgb, var(--accent) 15%, transparent);
  color: var(--accent);
}
.badge.default {
  background: color-mix(in srgb, var(--ok) 15%, transparent);
  color: var(--ok);
}
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
}
.repo-selected {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.back-btn {
  font-size: 0.8125rem;
}
.branch-actions {
  display: flex;
  justify-content: flex-end;
}
.error-state {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.warn-text {
  color: var(--warn);
  font-size: 0.875rem;
  margin: 0;
}
.small {
  font-size: 0.8125rem;
  padding: 0.3rem 0.75rem;
}
</style>
