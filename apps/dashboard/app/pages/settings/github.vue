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
  <section>
    <div class="head">
      <div>
        <NuxtLink to="/" class="muted small">← Projects</NuxtLink>
        <h1>GitHub Apps</h1>
      </div>
    </div>

    <p
      v-if="callbackMessage"
      :class="callbackMessage.ok ? 'ok-text' : 'error-text'"
      class="card callback-msg"
    >
      {{ callbackMessage.text }}
    </p>

    <!-- Master key ยังไม่ configure -->
    <div v-if="!masterKeyReady" class="card warn-card">
      <p class="warn-text">⚠️ Master key ยังไม่ได้ configure</p>
      <p class="muted">
        GitHub App credentials ต้องเข้ารหัสก่อนเก็บลงฐานข้อมูล —
        ตั้งค่า <code>ZIXPLOY_MASTER_KEY_FILE</code> ชี้ไฟล์ที่มี key ขนาด 32 byte (base64)
        แล้ว restart Control API
      </p>
      <pre class="hint">openssl rand -base64 32 &gt; /etc/zixploy/master.key
chmod 600 /etc/zixploy/master.key</pre>
    </div>

    <template v-else>
      <!-- รายการ apps -->
      <div class="card">
        <div class="card-head">
          <h2 class="section-title">GitHub Apps ของคุณ</h2>
          <button
            v-if="!showCreateForm"
            class="primary small"
            @click="showCreateForm = true"
          >
            + สร้าง GitHub App
          </button>
        </div>

        <!-- ฟอร์มสร้าง app -->
        <div v-if="showCreateForm" class="create-form">
          <p class="muted">
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
            <small class="muted">{{ newAppName.length }}/34 — ชื่อต้องไม่ซ้ำกับ App อื่นบน GitHub</small>
          </label>
          <label>
            <span>Organization (ไม่ระบุ = personal account)</span>
            <input v-model="newAppOrg" type="text" placeholder="my-org" />
          </label>

          <p v-if="createError" class="error-text">{{ createError }}</p>

          <div class="form-actions">
            <button class="primary" :disabled="creating" @click="createApp">
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

        <p v-if="appsPending" class="muted">กำลังโหลด…</p>

        <p v-else-if="apps.length === 0 && !showCreateForm" class="muted empty">
          ยังไม่มี GitHub App — สร้าง app แรกเพื่อเชื่อมต่อ repository
        </p>

        <ul v-else-if="apps.length > 0" class="app-list">
          <li v-for="app in apps" :key="app.id" class="app-item">
            <div class="app-main">
              <div class="app-title">
                <strong>{{ app.name }}</strong>
                <a :href="app.htmlUrl" target="_blank" rel="noopener noreferrer" class="small">
                  บน GitHub ↗
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
                  <span>{{ inst.accountLogin }}</span>
                  <span class="muted small">{{ inst.accountType }}</span>
                  <span v-if="inst.status === 'suspended'" class="badge warn">Suspended</span>
                  <span v-else class="badge ok">Active</span>
                </div>
              </div>
              <p v-else class="muted small no-install">ยังไม่ได้ติดตั้งกับ account ใด</p>
            </div>

            <div class="app-actions">
              <button class="secondary small" @click="installApp(app.id)">
                {{ installationsFor(app.id).length > 0 ? "เพิ่ม installation" : "Install" }}
              </button>
              <button class="danger small" @click="confirmDeleteId = app.id">ลบ</button>
            </div>
          </li>
        </ul>

        <p v-if="installError" class="error-text">{{ installError }}</p>
        <p v-if="deleteError" class="error-text">{{ deleteError }}</p>
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
  </section>
</template>

<style scoped>
.head {
  margin-bottom: 1.5rem;
}
h1 {
  margin: 0.35rem 0 0;
  font-size: 1.25rem;
}
.small {
  font-size: 0.8125rem;
}
.callback-msg {
  margin-bottom: 1rem;
}
.warn-card {
  border-color: var(--warn);
}
.warn-text {
  color: var(--warn);
  margin: 0 0 0.5rem;
  font-weight: 500;
}
.hint {
  background: var(--surface-alt, var(--bg));
  padding: 0.6rem 0.8rem;
  border-radius: var(--radius);
  font-size: 0.8125rem;
  overflow-x: auto;
  margin: 0.75rem 0 0;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}
.section-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}
.create-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  margin-bottom: 1rem;
}
.create-form label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.create-form label > span {
  font-size: 0.875rem;
  color: var(--muted);
}
.create-form input {
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  color: var(--text);
}
.form-actions {
  display: flex;
  gap: 0.75rem;
}
.empty {
  text-align: center;
  padding: 1.5rem 0;
  margin: 0;
}
.app-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.app-item {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
  justify-content: space-between;
  padding: 0.85rem 1rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  flex-wrap: wrap;
}
.app-main {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 240px;
  flex: 1;
}
.app-title {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.app-meta {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}
.install-list {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  margin-top: 0.4rem;
}
.install-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
}
.avatar {
  border-radius: 50%;
  object-fit: cover;
}
.no-install {
  margin: 0.3rem 0 0;
}
.app-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.badge {
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: 99px;
  font-weight: 600;
}
.badge.ok {
  background: color-mix(in srgb, var(--ok) 15%, transparent);
  color: var(--ok);
}
.badge.warn {
  background: color-mix(in srgb, var(--warn) 15%, transparent);
  color: var(--warn);
}
.danger.small,
.secondary.small,
.primary.small {
  font-size: 0.8125rem;
  padding: 0.3rem 0.75rem;
}
</style>
