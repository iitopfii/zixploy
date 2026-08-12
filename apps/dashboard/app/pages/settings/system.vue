<script setup lang="ts">
/**
 * ตั้งค่าระบบ (Phase 14) — dashboard domain
 *
 * ตั้ง domain ที่ใช้เข้า dashboard นอกเหนือจาก IP ที่ตัวติดตั้งตั้งไว้ — origin-guard
 * ยอมรับทันทีไม่ต้อง restart แสดง IP ของเครื่อง (A record) ให้ copy ไปตั้งใน DNS ด้วย
 */
const api = useApi();

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
      const body = error.value as { error?: { message?: string } } | null;
      saveError.value = body?.error?.message ?? "บันทึกไม่สำเร็จ";
      return;
    }
    saved.value = true;
    await refresh();
  } catch {
    saveError.value = "ติดต่อ API ไม่ได้";
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
      <h1>ตั้งค่าระบบ</h1>
      <p class="muted">domain ของ dashboard และข้อมูลเครือข่ายของเครื่อง</p>
    </header>

    <section class="card stack">
      <h2 class="section-title">Dashboard Domain</h2>
      <p class="muted small">
        ตั้ง domain ที่ใช้เข้า dashboard นี้ (เช่นชี้ domain ใหม่มาที่เครื่องหลังติดตั้งเสร็จ) —
        มีผลทันทีไม่ต้อง restart ถ้าไม่ตั้ง ระบบจะยอมรับเฉพาะ host ที่ตัวติดตั้งกำหนดไว้
        และการเข้าผ่าน domain อื่นจะถูกปฏิเสธ (INVALID_HOST)
      </p>

      <label>
        <span>Domain (ว่าง = ปิดการใช้ domain เพิ่มเติม)</span>
        <input v-model="domain" placeholder="zixploy.example.com" spellcheck="false" />
      </label>

      <p v-if="saveError" class="alert alert-bad">
        <AppIcon name="alert" :size="15" />
        <span>{{ saveError }}</span>
      </p>
      <p v-else-if="saved && !dirty" class="alert alert-ok">
        <AppIcon name="check" :size="15" />
        <span>บันทึกแล้ว — เข้า dashboard ผ่าน domain นี้ได้ทันที</span>
      </p>

      <div class="actions-end">
        <button class="primary" :disabled="!dirty || saving" @click="save">
          <span v-if="saving" class="spinner" />
          {{ saving ? "กำลังบันทึก…" : "บันทึก" }}
        </button>
      </div>
    </section>

    <section class="card stack">
      <h2 class="section-title">A Record สำหรับตั้งค่า DNS</h2>
      <p class="muted small">
        ชี้ domain มาที่เครื่องนี้โดยเพิ่ม A record ใน DNS ของผู้ให้บริการ domain —
        Type <code>A</code>, Name เป็นชื่อ domain/subdomain ที่ต้องการ, Value เป็น IP ด้านล่าง
      </p>

      <template v-if="settings?.serverIps.length">
        <div v-for="ip in settings.serverIps" :key="ip" class="ip-row">
          <code class="ip">{{ ip }}</code>
          <button class="ghost small" :title="`คัดลอก ${ip}`" @click="copyIp(ip)">
            <AppIcon :name="copiedIp === ip ? 'check' : 'copy'" :size="14" />
            {{ copiedIp === ip ? "คัดลอกแล้ว" : "คัดลอก" }}
          </button>
        </div>
      </template>
      <p v-else class="alert alert-warn">
        <AppIcon name="info" :size="15" />
        <span>
          ไม่พบ IP ของเครื่อง — ตั้ง <code>SERVER_IP</code> ใน <code>.env</code> ของการติดตั้งแล้ว
          restart control-api
        </span>
      </p>
    </section>
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
