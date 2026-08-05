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

/** Tab แต่ละอันเปิดจริงในเฟสที่ระบุ — ตอนนี้แสดงเป็น placeholder ที่บอกสถานะชัดเจน */
const tabs = [
  { key: "overview", label: "Overview", phase: null },
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
</script>

<template>
  <section>
    <p v-if="pending" class="muted">กำลังโหลด…</p>

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
</style>
