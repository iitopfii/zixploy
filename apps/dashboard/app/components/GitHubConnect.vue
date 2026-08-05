<script setup lang="ts">
/**
 * GitHub App connection component
 *
 * States:
 * - not-configured: ZIXPLOY_GITHUB_* env vars ไม่ได้ตั้งค่า
 * - loading: กำลังดึงข้อมูล
 * - no-installations: ยังไม่มี installation
 * - has-installations: มี installation พร้อมใช้
 * - error: ไม่สามารถดึงข้อมูลได้
 */
const api = useApi();
const route = useRoute();

// ตรวจสอบ github query param หลัง callback
const githubParam = computed(() => route.query.github as string | undefined);
const callbackMessage = computed(() => {
  if (githubParam.value === "installed") {
    const account = route.query.account as string | undefined;
    return account ? `เชื่อม GitHub App กับ ${account} สำเร็จ` : "เชื่อม GitHub App สำเร็จ";
  }
  if (githubParam.value === "error") return "เชื่อม GitHub App ไม่สำเร็จ — ลองใหม่อีกครั้ง";
  if (githubParam.value === "not-configured") return "GitHub App ยังไม่ได้ configure บนเซิร์ฟเวอร์";
  return null;
});

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

const connectLoading = ref(false);
const connectError = ref("");

async function connectGitHub() {
  connectLoading.value = true;
  connectError.value = "";
  try {
    const { data, error } = await api.api.v1.github["install-url"].get();
    if (error || !data?.url) {
      connectError.value = "ไม่สามารถสร้าง install URL ได้";
      return;
    }
    // เปิดหน้า GitHub ใน tab เดิม — GitHub จะ redirect กลับมา
    window.location.href = data.url;
  } catch {
    connectError.value = "ติดต่อ API ไม่ได้";
  } finally {
    connectLoading.value = false;
  }
}

const loading = computed(() => statusPending.value || installPending.value);
const configured = computed(() => status.value?.configured ?? false);
const activeInstallations = computed(
  () => installations.value?.items.filter((i) => i.status === "active") ?? [],
);
</script>

<template>
  <div class="github-connect">
    <!-- callback message -->
    <p v-if="callbackMessage" :class="githubParam === 'error' || githubParam === 'not-configured' ? 'error-text' : 'ok-text'" class="callback-msg">
      {{ callbackMessage }}
    </p>

    <template v-if="loading">
      <p class="muted">กำลังโหลด GitHub integration status…</p>
    </template>

    <template v-else-if="statusError || !configured">
      <div class="not-configured">
        <p class="muted">
          GitHub App ยังไม่ได้ configure — ตั้งค่า environment variables บนเซิร์ฟเวอร์
        </p>
        <ul class="env-list">
          <li><code>ZIXPLOY_GITHUB_APP_ID</code></li>
          <li><code>ZIXPLOY_GITHUB_APP_SLUG</code></li>
          <li><code>ZIXPLOY_GITHUB_APP_PRIVATE_KEY_FILE</code></li>
          <li><code>ZIXPLOY_GITHUB_WEBHOOK_SECRET</code></li>
        </ul>
      </div>
    </template>

    <template v-else>
      <!-- no installation yet -->
      <template v-if="activeInstallations.length === 0">
        <p class="muted">ยังไม่มี GitHub installation — คลิกด้านล่างเพื่อ install GitHub App</p>
        <p v-if="connectError" class="error-text">{{ connectError }}</p>
        <button class="primary" :disabled="connectLoading" @click="connectGitHub">
          {{ connectLoading ? "กำลัง redirect…" : "Install GitHub App" }}
        </button>
      </template>

      <!-- has installations -->
      <template v-else>
        <div class="install-list">
          <div
            v-for="install in activeInstallations"
            :key="install.id"
            class="install-item"
          >
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
          </div>
        </div>

        <div class="add-more">
          <button
            class="secondary small"
            :disabled="connectLoading"
            @click="connectGitHub"
          >
            {{ connectLoading ? "กำลัง redirect…" : "เพิ่ม installation ใหม่" }}
          </button>
          <button class="secondary small" @click="() => refreshInstallations()">รีเฟรช</button>
        </div>
        <p v-if="connectError" class="error-text">{{ connectError }}</p>
      </template>
    </template>
  </div>
</template>

<style scoped>
.github-connect {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.callback-msg {
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius);
  background: var(--surface-alt, var(--surface));
  margin: 0;
}
.not-configured {
  color: var(--muted);
}
.env-list {
  list-style: none;
  padding: 0;
  margin: 0.5rem 0 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.env-list code {
  font-size: 0.8125rem;
  background: var(--surface-alt, var(--surface));
  padding: 0.15rem 0.4rem;
  border-radius: 3px;
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
  margin-top: 0.25rem;
}
.small {
  font-size: 0.8125rem;
  padding: 0.3rem 0.75rem;
}
</style>
