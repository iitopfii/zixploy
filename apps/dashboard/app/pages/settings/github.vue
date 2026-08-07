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

const githubParam = computed(() => route.query.github as string | undefined);
const callbackMessage = computed(() => {
  if (githubParam.value === "app-created") {
    const name = route.query.app as string | undefined;
    return { ok: true, text: name ? `สร้าง GitHub App "${name}" สำเร็จ` : "สร้าง GitHub App สำเร็จ" };
  }
  if (githubParam.value === "installed") {
    const account = route.query.account as string | undefined;
    return { ok: true, text: account ? `ติดตั้งกับ ${account} สำเร็จ` : "ติดตั้ง GitHub App สำเร็จ" };
  }
  if (githubParam.value === "manifest-error") {
    return { ok: false, text: "สร้าง GitHub App ไม่สำเร็จ — code หมดอายุหรือถูกใช้ไปแล้ว ลองใหม่" };
  }
  if (githubParam.value === "error") {
    return { ok: false, text: "เกิดข้อผิดพลาด — ลองใหม่อีกครั้ง" };
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
    createError.value = "กรุณาระบุชื่อ app";
    return;
  }
  if (name.length > 34) {
    createError.value = "ชื่อ app ต้องไม่เกิน 34 ตัวอักษร (GitHub limit)";
    return;
  }

  creating.value = true;
  try {
    const org = newAppOrg.value.trim();
    const { data, error } = await api.api.v1.github.apps.manifest.post(
      org ? { name, organization: org } : { name },
    );
    if (error || !data) {
      const body = error?.value as { error?: { message?: string } } | null;
      createError.value = body?.error?.message ?? "สร้าง manifest ไม่สำเร็จ";
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
    createError.value = "ติดต่อ API ไม่ได้";
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
      installError.value = "ไม่สามารถสร้าง install URL ได้";
      return;
    }
    window.location.href = data.url;
  } catch {
    installError.value = "ติดต่อ API ไม่ได้";
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
      const body = error.value as { error?: { message?: string } } | null;
      deleteError.value = body?.error?.message ?? "ลบไม่สำเร็จ";
      return;
    }
    confirmDeleteId.value = null;
    await Promise.all([refreshApps(), refreshInstallations(), refreshStatus()]);
  } catch {
    deleteError.value = "ติดต่อ API ไม่ได้";
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
          Projects
        </NuxtLink>
        <h1>GitHub Apps</h1>
        <p class="muted small">จัดการ GitHub App ที่ใช้เชื่อมต่อ repository เข้ากับ project</p>
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
          <strong>Master key ยังไม่ได้ configure</strong>
          <span>
            GitHub App credentials ต้องเข้ารหัสก่อนเก็บลงฐานข้อมูล —
            ตั้งค่า <code>ZIXPLOY_MASTER_KEY_FILE</code> ชี้ไฟล์ที่มี key ขนาด 32 byte (base64)
            แล้ว restart Control API
          </span>
        </div>
      </div>
      <pre class="log-box hint-box">openssl rand -base64 32 &gt; /etc/zixploy/master.key
chmod 600 /etc/zixploy/master.key</pre>
    </div>

    <template v-else>
      <!-- รายการ apps -->
      <div class="card">
        <div class="row-between card-head">
          <h2 class="section-title">GitHub Apps ของคุณ</h2>
          <button v-if="!showCreateForm" class="primary small" @click="showCreateForm = true">
            <AppIcon name="plus" :size="14" />
            สร้าง GitHub App
          </button>
        </div>

        <!-- ฟอร์มสร้าง app -->
        <div v-if="showCreateForm" class="inset create-form">
          <p class="muted small">
            ระบบจะสร้าง GitHub App ให้อัตโนมัติ — GitHub จะถามยืนยันแล้วส่ง credentials กลับมา
            (เก็บแบบเข้ารหัส ไม่ต้องคัดลอก key เอง)
          </p>
          <label>
            <span>ชื่อ App</span>
            <input
              v-model="newAppName"
              type="text"
              maxlength="34"
              placeholder="เช่น Zixploy Deploy"
              @keyup.enter="createApp"
            />
            <span class="field-hint">
              {{ newAppName.length }}/34 — ชื่อต้องไม่ซ้ำกับ App อื่นบน GitHub
            </span>
          </label>
          <label>
            <span>Organization (ไม่ระบุ = personal account)</span>
            <input v-model="newAppOrg" type="text" placeholder="my-org" />
          </label>

          <p v-if="createError" class="alert alert-bad">
            <AppIcon name="alert" :size="15" />
            <span>{{ createError }}</span>
          </p>

          <div class="actions">
            <button class="primary" :disabled="creating" @click="createApp">
              <span v-if="creating" class="spinner" />
              {{ creating ? "กำลังเปิด GitHub…" : "สร้างบน GitHub" }}
            </button>
            <button
              class="secondary"
              :disabled="creating"
              @click="showCreateForm = false; createError = ''"
            >
              ยกเลิก
            </button>
          </div>
        </div>

        <div v-if="appsPending" class="stack app-loading">
          <span class="skeleton" style="height: 68px" />
          <span class="skeleton" style="height: 68px" />
        </div>

        <div v-else-if="apps.length === 0 && !showCreateForm" class="empty">
          <span class="empty-icon"><AppIcon name="github" :size="20" /></span>
          <span class="empty-title">ยังไม่มี GitHub App</span>
          <p class="small">สร้าง app แรกเพื่อเชื่อมต่อ repository</p>
        </div>

        <ul v-else-if="apps.length > 0" class="app-list">
          <li v-for="app in apps" :key="app.id" class="inset app-item">
            <div class="app-main">
              <div class="app-title">
                <strong>{{ app.name }}</strong>
                <a :href="app.htmlUrl" target="_blank" rel="noopener noreferrer" class="app-link">
                  บน GitHub
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
              <p v-else class="muted small no-install">ยังไม่ได้ติดตั้งกับ account ใด</p>
            </div>

            <div class="app-actions">
              <button class="secondary small" @click="installApp(app.id)">
                {{ installationsFor(app.id).length > 0 ? "เพิ่ม installation" : "Install" }}
              </button>
              <button class="danger small icon" title="ลบ" aria-label="ลบ" @click="confirmDeleteId = app.id">
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
      title="ลบ GitHub App"
      message="ลบ app นี้ออกจาก Zixploy — installations ที่ผูกอยู่จะถูกตัดการเชื่อมต่อและ auto deploy ของ projects ที่เกี่ยวข้องจะถูกปิด (app บน GitHub ยังอยู่ ต้องลบเองผ่าน GitHub settings)"
      confirm-label="ลบ"
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
