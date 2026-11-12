<script setup lang="ts">
/**
 * Container registries (0.1.24) — credential สำหรับ pull image private ของ compose component
 *
 * password ไม่เคยกลับมาจาก API — แก้ได้แค่ตั้งค่าใหม่ทั้งค่า (ช่องว่าง = ไม่เปลี่ยน)
 * ใช้ทุกครั้งที่ deploy pull image จาก host นั้น ไม่ต้องผูกกับ project
 */
const api = useApi();

interface Registry {
  id: string;
  registry: string;
  username: string;
  lastUsedAt: number | null;
}

const registries = ref<Registry[]>([]);
const loadError = ref("");

async function fetchRegistries() {
  loadError.value = "";
  try {
    const { data, error } = await api.api.v1.registries.get();
    if (error) {
      loadError.value = "โหลดรายการ registry ไม่ได้";
      return;
    }
    registries.value = (data?.registries ?? []) as Registry[];
  } catch {
    loadError.value = "ติดต่อ API ไม่ได้";
  }
}

await fetchRegistries();

function errMessage(error: unknown, fallback: string): string {
  const value = (error as { value?: { error?: { message?: string } } } | null)?.value;
  return value?.error?.message ?? fallback;
}

// ── เพิ่ม ──
const showAdd = ref(false);
const form = reactive({ registry: "ghcr.io", username: "", password: "" });
const formError = ref("");
const saving = ref(false);

async function addRegistry() {
  saving.value = true;
  formError.value = "";
  try {
    const { error } = await api.api.v1.registries.post({
      registry: form.registry.trim(),
      username: form.username.trim(),
      password: form.password,
    });
    if (error) {
      formError.value = errMessage(error, "เพิ่ม registry ไม่สำเร็จ");
      return;
    }
    showAdd.value = false;
    form.username = "";
    form.password = "";
    await fetchRegistries();
  } catch {
    formError.value = "ติดต่อ API ไม่ได้";
  } finally {
    saving.value = false;
  }
}

// ── เปลี่ยน password ──
const editingId = ref<string | null>(null);
const newPassword = ref("");
const editError = ref("");

async function savePassword(id: string) {
  editError.value = "";
  try {
    const { error } = await api.api.v1
      .registries({ registryId: id })
      .patch({ password: newPassword.value });
    if (error) {
      editError.value = errMessage(error, "บันทึกไม่สำเร็จ");
      return;
    }
    editingId.value = null;
    newPassword.value = "";
    await fetchRegistries();
  } catch {
    editError.value = "ติดต่อ API ไม่ได้";
  }
}

// ── ลบ ──
const confirmDeleteId = ref<string | null>(null);

async function removeRegistry(id: string) {
  try {
    await api.api.v1.registries({ registryId: id }).delete();
  } finally {
    confirmDeleteId.value = null;
    await fetchRegistries();
  }
}
</script>

<template>
  <section class="card stack">
    <div class="row-between">
      <h2 class="section-title">Container Registries</h2>
      <button class="small" @click="showAdd = !showAdd">
        <AppIcon name="plus" :size="14" />
        เพิ่ม registry
      </button>
    </div>
    <p class="muted small">
      credential สำหรับ pull image ที่เป็น private (เช่น <code>ghcr.io</code>) ของ component แบบ image —
      ใช้กับทุกโปรเจกต์ที่ pull จาก host นั้น · zixploy ไม่ <code>docker login</code> ค้างไว้บนเครื่อง
      แต่ส่ง credential ให้การ pull แต่ละครั้งแล้วลบทิ้ง
    </p>

    <div v-if="showAdd" class="inset stack">
      <label>
        <span>Registry host</span>
        <input v-model="form.registry" placeholder="ghcr.io" class="mono" />
      </label>
      <label>
        <span>Username</span>
        <input v-model="form.username" autocomplete="off" />
      </label>
      <label>
        <span>Password / token</span>
        <input v-model="form.password" type="password" autocomplete="new-password" />
      </label>
      <p class="muted tiny">
        ghcr.io: ใช้ GitHub personal access token ที่มีแค่ scope <code>read:packages</code>
      </p>
      <p v-if="formError" class="alert alert-bad small">
        <AppIcon name="alert" :size="13" />
        <span>{{ formError }}</span>
      </p>
      <button
        class="primary small"
        style="align-self: flex-start"
        :disabled="saving || !form.registry.trim() || !form.username.trim() || !form.password"
        @click="addRegistry"
      >
        <span v-if="saving" class="spinner" />
        {{ saving ? "กำลังบันทึก…" : "บันทึก" }}
      </button>
    </div>

    <p v-if="loadError" class="alert alert-bad small">
      <AppIcon name="alert" :size="13" />
      <span>{{ loadError }}</span>
    </p>
    <p v-else-if="registries.length === 0 && !showAdd" class="muted small">
      ยังไม่มี — image จาก registry ที่ไม่มี credential จะ pull แบบไม่ login (ใช้ได้กับ image public)
    </p>

    <ul v-else class="registry-list">
      <li v-for="r in registries" :key="r.id" class="inset stack">
        <div class="row-between">
          <div>
            <strong class="mono">{{ r.registry }}</strong>
            <span class="muted small"> · {{ r.username }}</span>
            <span class="muted tiny">
              · {{ r.lastUsedAt ? `ใช้ล่าสุด ${timeAgo(r.lastUsedAt)}` : "ยังไม่เคยใช้" }}
            </span>
          </div>
          <div class="actions">
            <button class="ghost small" @click="editingId = editingId === r.id ? null : r.id">
              เปลี่ยน password
            </button>
            <button class="ghost small danger" @click="confirmDeleteId = r.id">ลบ</button>
          </div>
        </div>
        <div v-if="editingId === r.id" class="row-gap">
          <input
            v-model="newPassword"
            type="password"
            autocomplete="new-password"
            placeholder="password / token ใหม่"
          />
          <button class="primary small" :disabled="!newPassword" @click="savePassword(r.id)">
            บันทึก
          </button>
        </div>
        <p v-if="editingId === r.id && editError" class="alert alert-bad small">
          <AppIcon name="alert" :size="13" />
          <span>{{ editError }}</span>
        </p>
        <div v-if="confirmDeleteId === r.id" class="row-gap">
          <span class="small">
            ลบ credential ของ <strong>{{ r.registry }}</strong>? deploy ครั้งถัดไปจะ pull แบบไม่ login
          </span>
          <button class="small danger" @click="removeRegistry(r.id)">ลบ</button>
          <button class="ghost small" @click="confirmDeleteId = null">ยกเลิก</button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.row-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
  flex-wrap: wrap;
}
.row-gap {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
}
.actions {
  display: flex;
  gap: var(--s-1);
}
.registry-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--s-2);
}
</style>
