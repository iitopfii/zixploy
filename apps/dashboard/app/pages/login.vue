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
      error.value = body?.error?.message ?? tr("auth.login.failed");
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
      <img src="/logo-mark.png" alt="Zixploy" class="logo" width="46" height="46" />
      <div>
        <h1>Zixploy</h1>
        <p class="muted small">Deployment Platform</p>
      </div>
    </div>

    <form class="card auth-card" @submit.prevent="submit">
      <div class="auth-head">
        <h2 class="section-title">{{ $t("auth.login.title") }}</h2>
        <p class="muted small">{{ $t("auth.login.subtitle") }}</p>
      </div>

      <label>
        <span>{{ $t("auth.login.username") }}</span>
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
        <span>{{ $t("auth.login.password") }}</span>
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
            :aria-label="showPassword ? $t('auth.login.hidePassword') : $t('auth.login.showPassword')"
            tabindex="-1"
            @click="showPassword = !showPassword"
          >
            {{ showPassword ? $t("common.hide") : $t("common.show") }}
          </button>
        </div>
      </label>

      <p v-if="error" class="alert alert-bad" role="alert">
        <AppIcon name="alert" :size="15" />
        <span>{{ error }}</span>
      </p>

      <button class="primary block" type="submit" :disabled="busy || !username || !password">
        <span v-if="busy" class="spinner" />
        {{ busy ? $t("auth.login.submitting") : $t("auth.login.submit") }}
      </button>
    </form>

    <p class="foot-note tiny muted">
      <AppIcon name="lock" :size="12" />
      {{ $t("auth.login.footnote") }}
    </p>

    <div class="locale-row">
      <LocaleSwitch />
    </div>
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
  width: 46px;
  height: 46px;
  flex-shrink: 0;
  object-fit: contain;
  /* เรืองแสงแรงกว่าใน sidebar เพราะเป็นจุดโฟกัสเดียวของหน้า */
  filter: drop-shadow(0 4px 14px rgb(91 140 255 / 38%));
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

.locale-row {
  display: flex;
  justify-content: center;
}

.foot-note {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
}
</style>
