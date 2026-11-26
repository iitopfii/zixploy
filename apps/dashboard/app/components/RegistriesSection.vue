<script setup lang="ts">
/**
 * Container registries (0.1.24) — credential สำหรับ pull image private ของ compose component
 *
 * password ไม่เคยกลับมาจาก API — แก้ได้แค่ตั้งค่าใหม่ทั้งค่า (ช่องว่าง = ไม่เปลี่ยน)
 * ใช้ทุกครั้งที่ deploy pull image จาก host นั้น ไม่ต้องผูกกับ project
 */
const api = useApi();
const { t } = useI18n();

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
      loadError.value = t("system.registries.error.load");
      return;
    }
    registries.value = (data?.registries ?? []) as Registry[];
  } catch {
    loadError.value = t("common.apiUnreachable");
  }
}

await fetchRegistries();

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
      formError.value = apiErrorMessage(error, "system.registries.error.add");
      return;
    }
    showAdd.value = false;
    form.username = "";
    form.password = "";
    await fetchRegistries();
  } catch {
    formError.value = t("common.apiUnreachable");
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
      editError.value = apiErrorMessage(error, "common.saveFailed");
      return;
    }
    editingId.value = null;
    newPassword.value = "";
    await fetchRegistries();
  } catch {
    editError.value = t("common.apiUnreachable");
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
        {{ $t("system.registries.add") }}
      </button>
    </div>
    <i18n-t scope="global" keypath="system.registries.intro" tag="p" class="muted small">
      <template #host><code>ghcr.io</code></template>
      <template #login><code>docker login</code></template>
    </i18n-t>

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
      <i18n-t scope="global" keypath="system.registries.ghcrHint" tag="p" class="muted tiny">
        <template #scope><code>read:packages</code></template>
      </i18n-t>
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
        {{ saving ? $t("common.saving") : $t("common.save") }}
      </button>
    </div>

    <p v-if="loadError" class="alert alert-bad small">
      <AppIcon name="alert" :size="13" />
      <span>{{ loadError }}</span>
    </p>
    <p v-else-if="registries.length === 0 && !showAdd" class="muted small">
      {{ $t("system.registries.empty") }}
    </p>

    <ul v-else class="registry-list">
      <li v-for="r in registries" :key="r.id" class="inset stack">
        <div class="row-between">
          <div>
            <strong class="mono">{{ r.registry }}</strong>
            <span class="muted small"> · {{ r.username }}</span>
            <span class="muted tiny">
              ·
              {{
                r.lastUsedAt
                  ? $t("system.registries.lastUsed", { time: timeAgo(r.lastUsedAt) })
                  : $t("system.registries.neverUsed")
              }}
            </span>
          </div>
          <div class="actions">
            <button class="ghost small" @click="editingId = editingId === r.id ? null : r.id">
              {{ $t("system.registries.changePassword") }}
            </button>
            <button class="ghost small danger" @click="confirmDeleteId = r.id">
              {{ $t("common.delete") }}
            </button>
          </div>
        </div>
        <div v-if="editingId === r.id" class="row-gap">
          <input
            v-model="newPassword"
            type="password"
            autocomplete="new-password"
            :placeholder="$t('system.registries.newPasswordPlaceholder')"
          />
          <button class="primary small" :disabled="!newPassword" @click="savePassword(r.id)">
            {{ $t("common.save") }}
          </button>
        </div>
        <p v-if="editingId === r.id && editError" class="alert alert-bad small">
          <AppIcon name="alert" :size="13" />
          <span>{{ editError }}</span>
        </p>
        <div v-if="confirmDeleteId === r.id" class="row-gap">
          <i18n-t scope="global" keypath="system.registries.confirmDelete" tag="span" class="small">
            <template #registry><strong>{{ r.registry }}</strong></template>
          </i18n-t>
          <button class="small danger" @click="removeRegistry(r.id)">
            {{ $t("common.delete") }}
          </button>
          <button class="ghost small" @click="confirmDeleteId = null">
            {{ $t("common.cancel") }}
          </button>
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
