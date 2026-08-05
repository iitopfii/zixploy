<script setup lang="ts">
const session = useSession();
const api = useApi();
const router = useRouter();

async function logout() {
  await api.api.v1.auth.logout.post();
  session.value = { authenticated: false };
  await router.push("/login");
}
</script>

<template>
  <div class="app">
    <header class="topbar">
      <NuxtLink to="/" class="brand">Zixploy</NuxtLink>
      <nav>
        <NuxtLink to="/">Projects</NuxtLink>
      </nav>
      <div class="right">
        <SystemHealth />
        <span v-if="session.authenticated" class="muted">{{ session.username }}</span>
        <button v-if="session.authenticated" @click="logout">Logout</button>
      </div>
    </header>

    <main class="content">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  padding: 0.75rem 1.5rem;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.brand {
  font-weight: 700;
  color: var(--text);
  font-size: 1.05rem;
}
.brand:hover {
  text-decoration: none;
}
nav {
  display: flex;
  gap: 1rem;
}
.right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 1rem;
}
.content {
  max-width: 960px;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}
</style>
