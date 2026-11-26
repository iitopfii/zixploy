<script setup lang="ts">
/**
 * GitHub Apps settings — สร้างและจัดการ GitHub Apps จากระบบเราเอง
 *
 * Flow การสร้าง app:
 * 1. Admin กรอกชื่อ app (+ organization ถ้าต้องการ) → POST /apps/manifest
 * 2. API คืน action URL + manifest JSON → เราสร้าง <form> POST ไป GitHub
 * 3. Admin ยืนยันบน GitHub → GitHub สร้าง app → redirect กลับมาที่ /apps/callback
 * 4. API exchange code → เก็บ credentials (encrypted) → redirect มาที่หน้านี้
 * 5. Admin กด Install → เลือก account/repos บน GitHub → setup callback
 */
const api = useApi();
const route = useRoute();
const { t } = useI18n();

const githubParam = computed(() => route.query.github as string | undefined);
const callbackMessage = computed(() => {
  if (githubParam.value === "app-created") {
    const name = route.query.app as string | undefined;
    return {
      ok: true,
      text: name ? t("github.callback.appCreatedNamed", { name }) : t("github.callback.appCreated"),
    };
  }
  if (githubParam.value === "installed") {
    const account = route.query.account as string | undefined;
    return {
      ok: true,
      text: account
        ? t("github.callback.installedNamed", { account })
        : t("github.callback.installed"),
    };
  }
  if (githubParam.value === "manifest-error") {
    return { ok: false, text: t("github.callback.manifestError") };
  }
  if (githubParam.value === "error") {
    return { ok: false, text: t("github.callback.error") };
  }
  return null;
});

const { data: status, refresh: refreshStatus } = await useAsyncData(
  "gh-settings-status",
  async () => {
    const { data } = await api.api.v1.github.status.get();
    return data;
  },
  { server: false },
);

const {
  data: appsData,
  pending: appsPending,
  refresh: refreshApps,
} = await useAsyncData(
  "gh-settings-apps",
  async () => {
    const { data } = await api.api.v1.github.apps.get();
    return data;
  },
  { server: false },
);

const { data: installationsData, refresh: refreshInstallations } = await useAsyncData(
  "gh-settings-installations",
  async () => {
    const { data } = await api.api.v1.github.installations.get();
    return data;
  },
  { server: false },
);

const apps = computed(() => appsData.value?.items ?? []);
const installations = computed(() => installationsData.value?.items ?? []);
const masterKeyReady = computed(() => status.value?.masterKeyConfigured ?? false);

/** installations ที่ผูกกับ app นี้ */
function installationsFor(appId: string) {
  return installations.value.filter((i) => i.appId === appId);
}

// === สร้าง App ใหม่ ===
const showCreateForm = ref(false);
const newAppName = ref("");
const newAppOrg = ref("");
const createError = ref("");
const creating = ref(false);

async function createApp() {
  createError.value = "";
  const name = newAppName.value.trim();
  if (!name) {
    createError.value = t("github.error.nameRequired");
    return;
  }
  if (name.length > 34) {
    createError.value = t("github.error.nameTooLong");
    return;
  }

  creating.value = true;
  try {
    const org = newAppOrg.value.trim();
    const { data, error } = await api.api.v1.github.apps.manifest.post(
      org ? { name, organization: org } : { name },
    );
    if (error || !data) {
      createError.value = apiErrorMessage(error, "github.error.manifest");
      return;
    }

    // GitHub manifest flow ต้อง POST form ไม่ใช่ GET redirect
    const form = document.createElement("form");
    form.method = "POST";
    form.action = data.action;
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "manifest";
    input.value = data.manifest;
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
  } catch {
    createError.value = t("common.apiUnreachable");
  } finally {
    creating.value = false;
  }
}

// === Install ===
const installError = ref("");

async function installApp(appId: string) {
  installError.value = "";
  try {
    const { data, error } = await api.api.v1.github.apps({ id: appId })["install-url"].get();
    if (error || !data?.url) {
      installError.value = t("github.error.installUrl");
      return;
    }
    window.location.href = data.url;
  } catch {
    installError.value = t("common.apiUnreachable");
  }
}

// === ลบ App ===
const confirmDeleteId = ref<string | null>(null);
const deleting = ref(false);
const deleteError = ref("");

const appPendingDelete = computed(() =>
  confirmDeleteId.value ? (apps.value.find((a) => a.id === confirmDeleteId.value) ?? null) : null,
);

async function deleteApp() {
  const id = confirmDeleteId.value;
  if (!id) return;
  deleting.value = true;
  deleteError.value = "";
  try {
    const { error } = await api.api.v1.github.apps({ id }).delete();
    if (error) {
      deleteError.value = apiErrorMessage(error, "common.deleteFailed");
      return;
    }
    confirmDeleteId.value = null;
    await Promise.all([refreshApps(), refreshInstallations(), refreshStatus()]);
  } catch {
    deleteError.value = t("common.apiUnreachable");
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div class="stack-lg">
    <header class="page-head">
      <div>
        <NuxtLink to="/" class="crumb">
          <AppIcon name="arrowLeft" :size="14" />
          {{ $t("nav.projects") }}
        </NuxtLink>
        <h1>{{ $t("nav.github") }}</h1>
        <p class="muted small">{{ $t("github.subtitle") }}</p>
      </div>
    </header>

    <p
      v-if="callbackMessage"
      class="alert"
      :class="callbackMessage.ok ? 'alert-ok' : 'alert-bad'"
    >
      <AppIcon :name="callbackMessage.ok ? 'check' : 'alert'" :size="15" />
      <span>{{ callbackMessage.text }}</span>
    </p>

    <!-- Master key ยังไม่ configure -->
    <div v-if="!masterKeyReady" class="card">
      <div class="alert alert-warn no-border">
        <AppIcon name="key" :size="16" />
        <div class="stack-sm">
          <strong>{{ $t("github.masterKey.title") }}</strong>
          <i18n-t scope="global" keypath="github.masterKey.body" tag="span">
            <template #file><code>ZIXPLOY_MASTER_KEY_FILE</code></template>
          </i18n-t>
        </div>
      </div>
      <pre class="log-box hint-box">openssl rand -base64 32 &gt; /etc/zixploy/master.key
chmod 600 /etc/zixploy/master.key</pre>
    </div>

    <template v-else>
      <!-- รายการ apps -->
      <div class="card">
        <div class="row-between card-head">
          <h2 class="section-title">{{ $t("github.apps.yours") }}</h2>
          <button v-if="!showCreateForm" class="primary small" @click="showCreateForm = true">
            <AppIcon name="plus" :size="14" />
            {{ $t("github.apps.create") }}
          </button>
        </div>

        <!-- ฟอร์มสร้าง app -->
        <div v-if="showCreateForm" class="inset create-form">
          <p class="muted small">
            {{ $t("github.apps.createIntro") }}
          </p>
          <label>
            <span>{{ $t("github.apps.name") }}</span>
            <input
              v-model="newAppName"
              type="text"
              maxlength="34"
              :placeholder="$t('github.apps.namePlaceholder')"
              @keyup.enter="createApp"
            />
            <span class="field-hint">
              {{ $t("github.apps.nameHint", { n: newAppName.length }) }}
            </span>
          </label>
          <label>
            <span>{{ $t("github.apps.organization") }}</span>
            <input v-model="newAppOrg" type="text" placeholder="my-org" />
          </label>

          <p v-if="createError" class="alert alert-bad">
            <AppIcon name="alert" :size="15" />
            <span>{{ createError }}</span>
          </p>

          <div class="actions">
            <button class="primary" :disabled="creating" @click="createApp">
              <span v-if="creating" class="spinner" />
              {{ creating ? $t("github.apps.opening") : $t("github.apps.createOnGithub") }}
            </button>
            <button
              class="secondary"
              :disabled="creating"
              @click="showCreateForm = false; createError = ''"
            >
              {{ $t("common.cancel") }}
            </button>
          </div>
        </div>

        <div v-if="appsPending" class="stack app-loading">
          <span class="skeleton" style="height: 68px" />
          <span class="skeleton" style="height: 68px" />
        </div>

        <div v-else-if="apps.length === 0 && !showCreateForm" class="empty">
          <span class="empty-icon"><AppIcon name="github" :size="20" /></span>
          <span class="empty-title">{{ $t("github.apps.empty") }}</span>
          <p class="small">{{ $t("github.apps.emptyHint") }}</p>
        </div>

        <ul v-else-if="apps.length > 0" class="app-list">
          <li v-for="app in apps" :key="app.id" class="inset app-item">
            <div class="app-main">
              <div class="app-title">
                <strong>{{ app.name }}</strong>
                <a :href="app.htmlUrl" target="_blank" rel="noopener noreferrer" class="app-link">
                  {{ $t("github.apps.onGithub") }}
                  <AppIcon name="external" :size="11" />
                </a>
              </div>
              <div class="app-meta muted small">
                <span>slug: <code>{{ app.slug }}</code></span>
                <span>App ID: {{ app.appId }}</span>
                <span v-if="app.ownerLogin">owner: {{ app.ownerLogin }}</span>
              </div>

              <!-- installations ของ app นี้ -->
              <div v-if="installationsFor(app.id).length > 0" class="install-list">
                <div
                  v-for="inst in installationsFor(app.id)"
                  :key="inst.id"
                  class="install-item"
                >
                  <img
                    v-if="inst.accountAvatarUrl"
                    :src="inst.accountAvatarUrl"
                    :alt="inst.accountLogin"
                    class="avatar"
                    width="20"
                    height="20"
                  />
                  <span v-else class="avatar avatar-fallback" aria-hidden="true">
                    {{ inst.accountLogin.charAt(0).toUpperCase() }}
                  </span>
                  <span>{{ inst.accountLogin }}</span>
                  <span class="muted small">{{ inst.accountType }}</span>
                  <span v-if="inst.status === 'suspended'" class="status status-mismatch">
                    Suspended
                  </span>
                  <span v-else class="status status-running">Active</span>
                </div>
              </div>
              <p v-else class="muted small no-install">{{ $t("github.apps.notInstalled") }}</p>
            </div>

            <div class="app-actions">
              <button class="secondary small" @click="installApp(app.id)">
                {{
                  installationsFor(app.id).length > 0
                    ? $t("github.apps.addInstallation")
                    : $t("github.apps.install")
                }}
              </button>
              <button
                class="danger small icon"
                :title="$t('common.delete')"
                :aria-label="$t('common.delete')"
                @click="confirmDeleteId = app.id"
              >
                <AppIcon name="trash" :size="14" />
              </button>
            </div>
          </li>
        </ul>

        <p v-if="installError" class="alert alert-bad">
          <AppIcon name="alert" :size="15" />
          <span>{{ installError }}</span>
        </p>
        <p v-if="deleteError" class="alert alert-bad">
          <AppIcon name="alert" :size="15" />
          <span>{{ deleteError }}</span>
        </p>
      </div>
    </template>

    <ConfirmDialog
      :open="confirmDeleteId !== null"
      :title="$t('github.apps.deleteTitle')"
      :message="$t('github.apps.deleteMessage')"
      :confirm-label="$t('common.delete')"
      :require-typed="appPendingDelete?.name ?? ''"
      :busy="deleting"
      @cancel="confirmDeleteId = null"
      @confirm="deleteApp"
    />
  </div>
</template>

<style scoped>
.page-head h1 {
  margin: 0.35rem 0 0.15rem;
}
.crumb {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: var(--t-sm);
  color: var(--text-muted);
}
.crumb:hover {
  color: var(--text-secondary);
  text-decoration: none;
}

.no-border {
  border: none;
  padding: 0;
  background: transparent;
}
.hint-box {
  margin-top: var(--s-3);
}

.card-head {
  margin-bottom: var(--s-4);
}

.create-form {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  margin-bottom: var(--s-4);
}
.create-form label {
  margin: 0;
}

.app-loading {
  gap: var(--s-3);
}

.app-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}
.app-item {
  display: flex;
  gap: var(--s-4);
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
}
.app-main {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  min-width: 240px;
  flex: 1;
}
.app-title {
  display: flex;
  align-items: baseline;
  gap: var(--s-3);
  flex-wrap: wrap;
}
.app-link {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: var(--t-sm);
}
.app-meta {
  display: flex;
  gap: var(--s-4);
  flex-wrap: wrap;
}
.install-list {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  margin-top: var(--s-1);
}
.install-item {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  font-size: var(--t-sm);
}
.avatar {
  width: 20px;
  height: 20px;
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
.no-install {
  margin: var(--s-1) 0 0;
}
.app-actions {
  display: flex;
  gap: var(--s-2);
  flex-wrap: wrap;
}
</style>
