<script setup lang="ts">
/**
 * App shell — sidebar ถาวรซ้าย + content ขวา
 *
 * Sidebar ยุบเป็น drawer ที่ <= 900px (ปุ่ม hamburger บน topbar mobile)
 * ปิด drawer อัตโนมัติเมื่อเปลี่ยนหน้า ไม่งั้นค้างทับ content หลังกด nav
 */
const session = useSession();
const api = useApi();
const router = useRouter();
const route = useRoute();

const navOpen = ref(false);
watch(
  () => route.fullPath,
  () => (navOpen.value = false),
);

const nav = [
  { to: "/", label: "Projects", icon: "grid" as const, exact: true },
  { to: "/databases", label: "Databases", icon: "database" as const, exact: false },
  { to: "/monitoring", label: "Monitoring", icon: "activity" as const, exact: false },
  { to: "/settings/github", label: "GitHub Apps", icon: "github" as const, exact: false },
];

const loggingOut = ref(false);
async function logout() {
  loggingOut.value = true;
  try {
    await api.api.v1.auth.logout.post();
    session.value = { authenticated: false };
    await router.push("/login");
  } finally {
    loggingOut.value = false;
  }
}

/** ตัวอักษรแรกของ username สำหรับ avatar — fallback เป็น "?" ถ้ายังไม่มี session */
const initial = computed(() => (session.value.username ?? "?").charAt(0).toUpperCase());
</script>

<template>
  <div class="shell">
    <!-- Mobile topbar -->
    <header class="mobile-bar">
      <button class="ghost icon" aria-label="เปิดเมนู" @click="navOpen = !navOpen">
        <AppIcon :name="navOpen ? 'x' : 'menu'" :size="18" />
      </button>
      <NuxtLink to="/" class="brand-mark">
        <img src="/logo-mark.png" alt="" class="logo" width="26" height="26" />
        <span class="brand-name">Zixploy</span>
      </NuxtLink>
      <SystemHealth compact />
    </header>

    <!-- Backdrop เฉพาะ mobile ตอน drawer เปิด -->
    <div v-if="navOpen" class="backdrop" @click="navOpen = false" />

    <aside class="sidebar" :class="{ open: navOpen }">
      <NuxtLink to="/" class="brand">
        <img src="/logo-mark.png" alt="Zixploy" class="logo" width="30" height="30" />
        <span class="brand-text">
          <span class="brand-name">Zixploy</span>
          <span class="brand-sub">Deployment Platform</span>
        </span>
      </NuxtLink>

      <nav class="nav" aria-label="หลัก">
        <p class="nav-heading">จัดการ</p>
        <NuxtLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="nav-item"
          :class="{ active: item.exact ? route.path === item.to : route.path.startsWith(item.to) }"
        >
          <AppIcon :name="item.icon" :size="16" />
          <span>{{ item.label }}</span>
        </NuxtLink>
      </nav>

      <div class="sidebar-foot">
        <SystemHealth />

        <div v-if="session.authenticated" class="user">
          <span class="avatar" aria-hidden="true">{{ initial }}</span>
          <span class="user-name truncate">{{ session.username }}</span>
          <button
            class="ghost icon small"
            :disabled="loggingOut"
            title="ออกจากระบบ"
            aria-label="ออกจากระบบ"
            @click="logout"
          >
            <AppIcon name="logout" :size="15" />
          </button>
        </div>
      </div>
    </aside>

    <main class="content">
      <div class="content-inner">
        <slot />
      </div>
    </main>
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
}

/* ── Sidebar ── */
.sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  gap: var(--s-5);
  padding: var(--s-4) var(--s-3);
  background: var(--bg-subtle);
  border-right: 1px solid var(--border-subtle);
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-2);
  color: var(--text);
  border-radius: var(--r);
}
.brand:hover {
  text-decoration: none;
}

/* โลโก้เป็น PNG พื้นโปร่ง — ตัวสายฟ้าที่เจาะทะลุ Z ปล่อยให้พื้นหลังลอดผ่าน
   จึงอ่านออกทั้งบน --bg-subtle (sidebar) และ --surface-1 (การ์ด login) */
.logo {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  object-fit: contain;
  /* เรืองแสงจาง ๆ ให้ mark ลอยจากพื้นมืด แทน box-shadow ที่จะเห็นเป็นกรอบสี่เหลี่ยม */
  filter: drop-shadow(0 2px 6px rgb(91 140 255 / 30%));
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  min-width: 0;
}
.brand-name {
  font-weight: 650;
  font-size: var(--t-md);
  letter-spacing: -0.015em;
}
.brand-sub {
  font-size: var(--t-xs);
  color: var(--text-muted);
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}

.nav-heading {
  font-size: var(--t-xs);
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-faint);
  padding: 0 var(--s-2);
  margin-bottom: var(--s-2);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: 0.45rem var(--s-2);
  border-radius: var(--r);
  color: var(--text-secondary);
  font-size: var(--t-sm);
  font-weight: 500;
  transition:
    background var(--fast),
    color var(--fast);
}
.nav-item:hover {
  background: var(--surface-2);
  color: var(--text);
  text-decoration: none;
}
.nav-item.active {
  background: var(--accent-tint);
  color: var(--accent);
}

.sidebar-foot {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding-top: var(--s-3);
  border-top: 1px solid var(--border-subtle);
}

.user {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-1);
}
.avatar {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--surface-3);
  border: 1px solid var(--border);
  font-size: var(--t-xs);
  font-weight: 600;
  color: var(--text-secondary);
}
.user-name {
  flex: 1;
  font-size: var(--t-sm);
  color: var(--text-secondary);
}

/* ── Content ── */
.content {
  min-width: 0;
}
.content-inner {
  max-width: 1180px;
  margin: 0 auto;
  padding: var(--s-6) var(--s-5) var(--s-7);
}

/* ── Mobile ── */
.mobile-bar {
  display: none;
}
.backdrop {
  display: none;
}

@media (max-width: 900px) {
  .shell {
    grid-template-columns: 1fr;
  }

  .mobile-bar {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    height: var(--topbar-h);
    padding: 0 var(--s-3);
    background: var(--bg-subtle);
    border-bottom: 1px solid var(--border-subtle);
    position: sticky;
    top: 0;
    z-index: 30;
  }
  .mobile-bar .brand-mark {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--text);
    margin-right: auto;
  }
  .mobile-bar .brand-mark:hover {
    text-decoration: none;
  }
  .mobile-bar .logo {
    width: 26px;
    height: 26px;
  }

  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    width: 260px;
    z-index: 40;
    transform: translateX(-100%);
    transition: transform var(--normal);
    box-shadow: var(--shadow-lg);
  }
  .sidebar.open {
    transform: translateX(0);
  }

  .backdrop {
    display: block;
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 55%);
    z-index: 35;
  }

  .content-inner {
    padding: var(--s-5) var(--s-4) var(--s-6);
  }
}
</style>
