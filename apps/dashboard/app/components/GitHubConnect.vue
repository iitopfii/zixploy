<script setup lang="ts">
/**
 * GitHub App connection prompt — แสดงในหน้า project เมื่อยังไม่มี installation
 *
 * States:
 * - no-master-key: ZIXPLOY_MASTER_KEY_FILE ไม่ได้ตั้งค่า → สร้าง app ไม่ได้
 * - no-app: ยังไม่มี GitHub App → ชวนไปหน้า settings เพื่อสร้าง
 * - no-installation: มี app แล้วแต่ยังไม่ได้ install → ปุ่ม Install
 * - has-installations: พร้อมใช้ — แสดงรายการ account
 *
 * การสร้าง/ลบ GitHub App ทำที่ /settings/github
 */
const api = useApi();

const {
  data: status,
  pending: statusPending,
  error: statusError,
} = await useAsyncData(
  "github-status",
  async () => {
    const { data, error } = await api.api.v1.github.status.get();
    if (error) throw new Error("status error");
    return data;
  },
  { server: false },
);

const { data: appsData, pending: appsPending } = await useAsyncData(
  "github-apps-connect",
  async () => {
    const { data, error } = await api.api.v1.github.apps.get();
    if (error) return null;
    return data;
  },
  { server: false },
);

const {
  data: installations,
  pending: installPending,
  refresh: refreshInstallations,
} = await useAsyncData(
  "github-installations",
  async () => {
    const { data, error } = await api.api.v1.github.installations.get();
    if (error) return null;
    return data;
  },
  { server: false },
);

const installLoading = ref(false);
const installError = ref("");

async function installApp(appId: string) {
  installLoading.value = true;
  installError.value = "";
  try {
    const { data, error } = await api.api.v1.github.apps({ id: appId })["install-url"].get();
    if (error || !data?.url) {
      installError.value = "ไม่สามารถสร้าง install URL ได้";
      return;
    }
    // เปิดหน้า GitHub ใน tab เดิม — GitHub จะ redirect กลับมา
    window.location.href = data.url;
  } catch {
    installError.value = "ติดต่อ API ไม่ได้";
  } finally {
    installLoading.value = false;
  }
}

const loading = computed(() => statusPending.value || installPending.value || appsPending.value);
const masterKeyReady = computed(() => status.value?.masterKeyConfigured ?? false);
const apps = computed(() => appsData.value?.items ?? []);
const activeInstallations = computed(
  () => installations.value?.items.filter((i) => i.status === "active") ?? [],
);
</script>

<template>
  <div class="github-connect">
    <template v-if="loading">
      <p class="muted">กำลังโหลด GitHub integration status…</p>
    </template>

    <!-- Master key ยังไม่ configure -->
    <template v-else-if="statusError || !masterKeyReady">
      <div class="not-configured">
        <p class="muted">
          Master key ยังไม่ได้ configure — GitHub App credentials ต้องเข้ารหัสก่อนเก็บ
        </p>
        <p class="muted small">
          ตั้งค่า <code>ZIXPLOY_MASTER_KEY_FILE</code> บนเซิร์ฟเวอร์แล้ว restart Control API
        </p>
        <NuxtLink to="/settings/github" class="small">ดูรายละเอียดที่ GitHub Apps settings →</NuxtLink>
      </div>
    </template>

    <!-- ยังไม่มี GitHub App -->
    <template v-else-if="apps.length === 0">
      <div class="no-app">
        <p class="muted">ยังไม่มี GitHub App — สร้าง app จากหน้า settings เพื่อเชื่อมต่อ repository</p>
        <NuxtLink to="/settings/github" class="btn-link primary">สร้าง GitHub App</NuxtLink>
      </div>
    </template>

    <!-- มี app แล้วแต่ยังไม่ได้ install -->
    <template v-else-if="activeInstallations.length === 0">
      <p class="muted">มี GitHub App แล้ว แต่ยังไม่ได้ติดตั้งกับ account ใด</p>
      <p v-if="installError" class="error-text">{{ installError }}</p>
      <div class="app-buttons">
        <button
          v-for="app in apps"
          :key="app.id"
          class="primary"
          :disabled="installLoading"
          @click="installApp(app.id)"
        >
          {{ installLoading ? "กำลัง redirect…" : `Install ${app.name}` }}
        </button>
      </div>
    </template>

    <!-- พร้อมใช้ -->
    <template v-else>
      <div class="install-list">
        <div v-for="install in activeInstallations" :key="install.id" class="install-item">
          <img
            v-if="install.accountAvatarUrl"
            :src="install.accountAvatarUrl"
            :alt="install.accountLogin"
            class="avatar"
            width="24"
            height="24"
          />
          <span class="account-name">{{ install.accountLogin }}</span>
          <span class="account-type muted">{{ install.accountType }}</span>
          <span v-if="install.appName" class="muted small">via {{ install.appName }}</span>
        </div>
      </div>

      <div class="add-more">
        <NuxtLink to="/settings/github" class="btn-link secondary small">จัดการ GitHub Apps</NuxtLink>
        <button class="secondary small" @click="() => refreshInstallations()">รีเฟรช</button>
      </div>
      <p v-if="installError" class="error-text">{{ installError }}</p>
    </template>
  </div>
</template>

<style scoped>
.github-connect {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.not-configured,
.no-app {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: flex-start;
}
.not-configured code {
  font-size: 0.8125rem;
  background: var(--surface-alt, var(--surface));
  padding: 0.15rem 0.4rem;
  border-radius: 3px;
}
.btn-link {
  display: inline-block;
  padding: 0.4rem 0.9rem;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  text-decoration: none;
}
.btn-link.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.btn-link:hover {
  text-decoration: none;
}
.app-buttons {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.install-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.install-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.avatar {
  border-radius: 50%;
  object-fit: cover;
}
.account-name {
  font-weight: 500;
}
.account-type {
  font-size: 0.8125rem;
}
.add-more {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-items: center;
  margin-top: 0.25rem;
}
.small {
  font-size: 0.8125rem;
  padding: 0.3rem 0.75rem;
}
.btn-link.small {
  padding: 0.3rem 0.75rem;
}
</style>
