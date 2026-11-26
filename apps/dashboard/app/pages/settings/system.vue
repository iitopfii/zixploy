<script setup lang="ts">
/**
 * ตั้งค่าระบบ (Phase 14) — dashboard domain
 *
 * ตั้ง domain ที่ใช้เข้า dashboard นอกเหนือจาก IP ที่ตัวติดตั้งตั้งไว้ — origin-guard
 * ยอมรับทันทีไม่ต้อง restart แสดง IP ของเครื่อง (A record) ให้ copy ไปตั้งใน DNS ด้วย
 */
const api = useApi();
const { t } = useI18n();

const { data: settings, refresh } = await useAsyncData("system-settings", async () => {
  const { data } = await api.api.v1.system.settings.get();
  return data;
});

const domain = ref("");
watch(
  () => settings.value?.dashboardDomain,
  (v) => {
    domain.value = v ?? "";
  },
  { immediate: true },
);

const dirty = computed(() => domain.value.trim() !== (settings.value?.dashboardDomain ?? ""));

const saving = ref(false);
const saved = ref(false);
const saveError = ref("");

async function save() {
  saveError.value = "";
  saved.value = false;
  saving.value = true;
  try {
    const value = domain.value.trim();
    const { error } = await api.api.v1.system.settings.put({
      dashboardDomain: value === "" ? null : value,
    });
    if (error) {
      saveError.value = apiErrorMessage(error, "common.saveFailed");
      return;
    }
    saved.value = true;
    await refresh();
  } catch {
    saveError.value = t("common.apiUnreachable");
  } finally {
    saving.value = false;
  }
}

const copiedIp = ref("");
async function copyIp(ip: string) {
  try {
    await navigator.clipboard.writeText(ip);
    copiedIp.value = ip;
    setTimeout(() => {
      if (copiedIp.value === ip) copiedIp.value = "";
    }, 2000);
  } catch {
    // clipboard ไม่พร้อม (ไม่ใช่ secure context) — ผู้ใช้เลือก copy เองได้จาก <code>
  }
}
</script>

<template>
  <div class="stack-lg">
    <header>
      <h1>{{ $t("nav.system") }}</h1>
      <p class="muted">{{ $t("system.subtitle") }}</p>
    </header>

    <section class="card stack">
      <h2 class="section-title">Dashboard Domain</h2>
      <p class="muted small">
        {{ $t("system.domain.intro") }}
      </p>

      <label>
        <span>{{ $t("system.domain.label") }}</span>
        <input v-model="domain" placeholder="zixploy.example.com" spellcheck="false" />
      </label>

      <p v-if="saveError" class="alert alert-bad">
        <AppIcon name="alert" :size="15" />
        <span>{{ saveError }}</span>
      </p>
      <p v-else-if="saved && !dirty" class="alert alert-ok">
        <AppIcon name="check" :size="15" />
        <span>{{ $t("system.domain.saved") }}</span>
      </p>

      <div class="actions-end">
        <button class="primary" :disabled="!dirty || saving" @click="save">
          <span v-if="saving" class="spinner" />
          {{ saving ? $t("common.saving") : $t("common.save") }}
        </button>
      </div>
    </section>

    <section class="card stack">
      <h2 class="section-title">{{ $t("system.dns.title") }}</h2>
      <i18n-t scope="global" keypath="system.dns.intro" tag="p" class="muted small">
        <template #type><code>A</code></template>
      </i18n-t>

      <template v-if="settings?.serverIps.length">
        <div v-for="ip in settings.serverIps" :key="ip" class="ip-row">
          <code class="ip">{{ ip }}</code>
          <button class="ghost small" :title="$t('system.dns.copyIp', { ip })" @click="copyIp(ip)">
            <AppIcon :name="copiedIp === ip ? 'check' : 'copy'" :size="14" />
            {{ copiedIp === ip ? $t("common.copied") : $t("common.copy") }}
          </button>
        </div>
      </template>
      <p v-else class="alert alert-warn">
        <AppIcon name="info" :size="15" />
        <i18n-t scope="global" keypath="system.dns.noIp" tag="span">
          <template #name><code>SERVER_IP</code></template>
          <template #file><code>.env</code></template>
        </i18n-t>
      </p>
    </section>

    <RegistriesSection />
  </div>
</template>

<style scoped>
header h1 {
  margin-bottom: var(--s-1);
}

.ip-row {
  display: flex;
  align-items: center;
  gap: var(--s-3);
}
.ip {
  font-size: var(--t-md);
  padding: var(--s-2) var(--s-3);
  background: var(--surface-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-sm);
}
</style>
