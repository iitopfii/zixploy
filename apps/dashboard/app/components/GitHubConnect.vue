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
  <div class="stack">
    <template v-if="loading">
      <div class="stack-sm">
        <span class="skeleton" style="height: 1em; width: 70%" />
        <span class="skeleton" style="height: 1em; width: 40%" />
      </div>
    </template>

    <!-- Master key ยังไม่ configure -->
    <template v-else-if="statusError || !masterKeyReady">
      <div class="alert alert-warn">
        <AppIcon name="key" :size="16" />
        <div class="stack-sm">
          <strong>Master key ยังไม่ได้ configure</strong>
          <span>GitHub App credentials ต้องเข้ารหัสก่อนเก็บ — ตั้งค่า <code>ZIXPLOY_MASTER_KEY_FILE</code> บนเซิร์ฟเวอร์แล้ว restart Control API</span>
          <NuxtLink to="/settings/github" class="inline-link">
            ดูรายละเอียดที่ GitHub Apps settings
            <AppIcon name="chevronRight" :size="12" />
          </NuxtLink>
        </div>
      </div>
    </template>

    <!-- ยังไม่มี GitHub App -->
    <template v-else-if="apps.length === 0">
      <div class="empty">
        <span class="empty-icon"><AppIcon name="github" :size="20" /></span>
        <span class="empty-title">ยังไม่มี GitHub App</span>
        <p class="small">สร้าง app จากหน้า settings เพื่อเชื่อมต่อ repository</p>
        <NuxtLink to="/settings/github" class="btn primary">
          สร้าง GitHub App
        </NuxtLink>
      </div>
    </template>

    <!-- มี app แล้วแต่ยังไม่ได้ install -->
    <template v-else-if="activeInstallations.length === 0">
      <p class="muted small">มี GitHub App แล้ว แต่ยังไม่ได้ติดตั้งกับ account ใด</p>
      <p v-if="installError" class="alert alert-bad">
        <AppIcon name="alert" :size="15" />
        <span>{{ installError }}</span>
      </p>
      <div class="actions">
        <button
          v-for="app in apps"
          :key="app.id"
          class="primary"
          :disabled="installLoading"
          @click="installApp(app.id)"
        >
          <span v-if="installLoading" class="spinner" />
          {{ installLoading ? "กำลัง redirect…" : `Install ${app.name}` }}
        </button>
      </div>
    </template>

    <!-- พร้อมใช้ -->
    <template v-else>
      <div class="install-list">
        <div v-for="install in activeInstallations" :key="install.id" class="inset install-item">
          <img
            v-if="install.accountAvatarUrl"
            :src="install.accountAvatarUrl"
            :alt="install.accountLogin"
            class="avatar"
            width="24"
            height="24"
          />
          <span v-else class="avatar avatar-fallback" aria-hidden="true">
            {{ install.accountLogin.charAt(0).toUpperCase() }}
          </span>
          <span class="account-name">{{ install.accountLogin }}</span>
          <span class="muted small">{{ install.accountType }}</span>
          <span v-if="install.appName" class="muted tiny">via {{ install.appName }}</span>
        </div>
      </div>

      <div class="row wrap">
        <NuxtLink to="/settings/github" class="btn secondary small">จัดการ GitHub Apps</NuxtLink>
        <button class="ghost small" @click="() => refreshInstallations()">
          <AppIcon name="refresh" :size="13" />
          รีเฟรช
        </button>
      </div>
      <p v-if="installError" class="alert alert-bad">
        <AppIcon name="alert" :size="15" />
        <span>{{ installError }}</span>
      </p>
    </template>
  </div>
</template>

<style scoped>
.inline-link {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  font-size: var(--t-sm);
}

.install-list {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.install-item {
  display: flex;
  align-items: center;
  gap: var(--s-3);
}
.avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.avatar-fallback {
  display: grid;
  place-items: center;
  background: var(--surface-3);
  border: 1px solid var(--border);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
}
.account-name {
  font-weight: 500;
}
</style>
