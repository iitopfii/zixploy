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
  <form class="card login" @submit.prevent="submit">
    <h1>Zixploy</h1>
    <p class="muted">เข้าสู่ระบบเพื่อจัดการ deployment</p>

    <label>
      <span>Username</span>
      <input v-model="username" autocomplete="username" autofocus required />
    </label>

    <label>
      <span>Password</span>
      <input v-model="password" type="password" autocomplete="current-password" required />
    </label>

    <p v-if="error" class="error-text">{{ error }}</p>

    <button class="primary" type="submit" :disabled="busy || !username || !password">
      {{ busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ" }}
    </button>
  </form>
</template>

<style scoped>
.login {
  width: 100%;
  max-width: 360px;
}
h1 {
  margin: 0;
  font-size: 1.35rem;
}
p.muted {
  margin: 0.25rem 0 1.5rem;
}
button {
  width: 100%;
}
</style>
