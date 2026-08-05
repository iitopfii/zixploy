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

// Create Project wizard ตัวเต็มมาใน phase 2 (ต้องเลือก repository ก่อน) — ตอนนี้สร้างด้วยชื่อก่อน
const creating = ref(false);
const newName = ref("");
const createError = ref("");

async function create() {
  createError.value = "";
  const { error: apiError } = await api.api.v1.projects.post({ name: newName.value.trim() });
  if (apiError) {
    createError.value = "สร้าง project ไม่สำเร็จ";
    return;
  }
  newName.value = "";
  creating.value = false;
  await refresh();
}
</script>

<template>
  <section>
    <div class="head">
      <h1>Projects</h1>
      <button class="primary" @click="creating = !creating">New Project</button>
    </div>

    <form v-if="creating" class="card create" @submit.prevent="create">
      <label>
        <span>ชื่อ project</span>
        <input v-model="newName" autofocus placeholder="my-app" />
      </label>
      <p v-if="createError" class="error-text">{{ createError }}</p>
      <p class="muted small">
        การเชื่อม repository และ branch ทำได้หลังสร้าง project (Phase 2)
      </p>
      <div class="actions">
        <button type="button" @click="creating = false">ยกเลิก</button>
        <button class="primary" type="submit" :disabled="!newName.trim()">สร้าง</button>
      </div>
    </form>

    <p v-if="pending" class="muted">กำลังโหลด…</p>

    <div v-else-if="error" class="card">
      <p class="error-text">โหลดรายการ project ไม่สำเร็จ</p>
      <button @click="refresh()">ลองใหม่</button>
    </div>

    <div v-else-if="!projects?.length" class="card empty">
      <p>ยังไม่มี project</p>
      <p class="muted small">สร้าง project แรกเพื่อเริ่ม deploy จาก GitHub repository</p>
    </div>

    <ul v-else class="list">
      <li v-for="project in projects" :key="project.id">
        <NuxtLink :to="`/projects/${project.id}`" class="card row">
          <div>
            <strong>{{ project.name }}</strong>
            <p class="muted small">
              {{ project.repoFullName ?? "ยังไม่ได้เชื่อม repository" }}
              <template v-if="project.branch"> · {{ project.branch }}</template>
            </p>
          </div>
          <span class="status" :class="`status-${project.status}`">{{ project.status }}</span>
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}
h1 {
  margin: 0;
  font-size: 1.25rem;
}
.create {
  margin-bottom: 1.5rem;
}
.create .actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.75rem;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  color: inherit;
}
.row:hover {
  text-decoration: none;
  background: var(--surface-hover);
}
.row strong {
  display: block;
}
.empty {
  text-align: center;
  padding: 3rem 1.25rem;
}
.small {
  font-size: 0.875rem;
  margin: 0.25rem 0 0;
}
</style>
