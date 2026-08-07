<script setup lang="ts">
definePageMeta({ layout: "blank" });

const api = useApi();
const session = useSession();
const route = useRoute();
const router = useRouter();

const username = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);
const showPassword = ref(false);

async function submit() {
  error.value = "";
  busy.value = true;
  try {
    const { data, error: apiError } = await api.api.v1.auth.login.post({
      username: username.value,
      password: password.value,
    });

    if (apiError) {
      // แสดงข้อความจาก API ตาม code — ไม่เดาสาเหตุเอง
      const body = apiError.value as { error?: { message?: string } } | null;
      error.value = body?.error?.message ?? "เข้าสู่ระบบไม่สำเร็จ";
      password.value = "";
      return;
    }

    session.value = data ?? { authenticated: false };
    const next = typeof route.query.next === "string" ? route.query.next : "/";
    await router.push(next);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="auth">
    <div class="auth-brand">
      <span class="logo" aria-hidden="true">Z</span>
      <div>
        <h1>Zixploy</h1>
        <p class="muted small">Deployment Platform</p>
      </div>
    </div>

    <form class="card auth-card" @submit.prevent="submit">
      <div class="auth-head">
        <h2 class="section-title">เข้าสู่ระบบ</h2>
        <p class="muted small">ใช้บัญชีผู้ดูแลระบบเพื่อจัดการ deployment</p>
      </div>

      <label>
        <span>ชื่อผู้ใช้</span>
        <input
          v-model="username"
          autocomplete="username"
          autofocus
          required
          :disabled="busy"
          placeholder="admin"
        />
      </label>

      <label>
        <span>รหัสผ่าน</span>
        <div class="pw-field">
          <input
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="current-password"
            required
            :disabled="busy"
            placeholder="••••••••••••"
          />
          <button
            type="button"
            class="ghost small pw-toggle"
            :aria-label="showPassword ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'"
            tabindex="-1"
            @click="showPassword = !showPassword"
          >
            {{ showPassword ? "ซ่อน" : "แสดง" }}
          </button>
        </div>
      </label>

      <p v-if="error" class="alert alert-bad" role="alert">
        <AppIcon name="alert" :size="15" />
        <span>{{ error }}</span>
      </p>

      <button class="primary block" type="submit" :disabled="busy || !username || !password">
        <span v-if="busy" class="spinner" />
        {{ busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ" }}
      </button>
    </form>

    <p class="foot-note tiny muted">
      <AppIcon name="lock" :size="12" />
      การเชื่อมต่อถูกป้องกันด้วย session cookie และ CSRF token
    </p>
  </div>
</template>

<style scoped>
.auth {
  width: 100%;
  max-width: 380px;
  display: flex;
  flex-direction: column;
  gap: var(--s-5);
}

.auth-brand {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  justify-content: center;
}
.auth-brand h1 {
  font-size: var(--t-lg);
  line-height: 1.2;
}
.auth-brand p {
  margin-top: 0.05rem;
}

.logo {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border-radius: var(--r);
  background: linear-gradient(140deg, var(--accent) 0%, #8b5cf6 100%);
  color: #05080f;
  font-weight: 800;
  font-size: 19px;
  letter-spacing: -0.02em;
  box-shadow: 0 4px 16px rgb(91 140 255 / 30%);
}

.auth-card {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  padding: var(--s-5);
  box-shadow: var(--shadow-lg), var(--shadow-inset);
  background: var(--surface-1);
}

.auth-head {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.auth-card label {
  margin: 0;
}

.pw-field {
  position: relative;
  display: flex;
  align-items: center;
}
.pw-field input {
  padding-right: 4rem;
}
.pw-toggle {
  position: absolute;
  right: 4px;
  height: 26px;
  color: var(--text-muted);
}

.foot-note {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
}
</style>
