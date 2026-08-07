<script setup lang="ts">
/**
 * แถบเวอร์ชัน + ปุ่มอัปเดต — Phase 12
 *
 * อยู่ท้าย sidebar เพราะเป็นข้อมูลระดับระบบ ไม่ผูกกับหน้าไหน
 * ตัวตรวจอยู่ฝั่ง server และ cache ไว้ 30 นาที — component นี้แค่แสดงผล
 */
const api = useApi();

const { data, refresh } = await useAsyncData(
  "system-version",
  async () => (await api.api.v1.system.version.get({ query: {} })).data,
  { server: false, lazy: true },
);

const starting = ref(false);
const errorMsg = ref("");
const confirmUpdate = ref(false);

/**
 * ระหว่างอัปเดต container ทั้งหมดถูก recreate — API จะขาดช่วงหลายสิบวินาที
 * poll ต่อไปเรื่อย ๆ โดยไม่ถือว่า error คือความล้มเหลว จนกว่าจะกลับมาพร้อมเวอร์ชันใหม่
 */
const updating = computed(() => starting.value || data.value?.updating === true);

onMounted(() => {
  let timer: ReturnType<typeof setInterval> | null = null;
  watch(
    updating,
    (busy) => {
      if (timer) clearInterval(timer);
      // ระหว่างอัปเดตถามถี่เพื่อจับจังหวะที่ระบบกลับมา ปกติแล้วนาน ๆ ครั้งพอ
      timer = setInterval(() => refresh(), busy ? 5_000 : 15 * 60_000);
    },
    { immediate: true },
  );
  onUnmounted(() => timer && clearInterval(timer));
});

async function startUpdate() {
  starting.value = true;
  errorMsg.value = "";
  try {
    const { error } = await api.api.v1.system.update.post({});
    if (error) {
      const body = error.value as { error?: { message?: string } } | null;
      errorMsg.value = body?.error?.message ?? "สั่งอัปเดตไม่สำเร็จ";
      starting.value = false;
      return;
    }
    confirmUpdate.value = false;
    await refresh();
  } catch {
    errorMsg.value = "ติดต่อ API ไม่ได้";
    starting.value = false;
  }
}
</script>

<template>
  <div v-if="data" class="update-box">
    <!-- กำลังอัปเดต -->
    <div v-if="updating" class="row-updating">
      <span class="spinner" />
      <span class="tiny">กำลังอัปเดต… ระบบจะรีสตาร์ทเอง</span>
    </div>

    <!-- มีเวอร์ชันใหม่ -->
    <button
      v-else-if="data.updateAvailable"
      class="update-btn"
      :title="`อัปเดตเป็น ${data.latest}`"
      @click="confirmUpdate = true"
    >
      <AppIcon name="refresh" :size="14" />
      <span>มีอัปเดตใหม่</span>
      <span class="dot" aria-hidden="true" />
    </button>

    <p v-if="errorMsg" class="tiny bad-text err">{{ errorMsg }}</p>

    <p class="version tiny muted" :title="data.error ?? undefined">
      Version {{ data.current }}
      <span v-if="data.error" class="warn-text">· ตรวจอัปเดตไม่ได้</span>
    </p>

    <ConfirmDialog
      :open="confirmUpdate"
      title="อัปเดต Zixploy"
      :message="`อัปเดตจาก ${data.current} เป็น ${data.latest} — ระบบจะรีสตาร์ทและใช้ไม่ได้ประมาณ 1-2 นาที แอปที่ deploy ไว้ยังทำงานต่อตามปกติ ไม่ถูกแตะ`"
      confirm-label="อัปเดตเลย"
      :busy="starting"
      @cancel="confirmUpdate = false"
      @confirm="startUpdate"
    />
  </div>
</template>

<style scoped>
.update-box {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}

.update-btn {
  width: 100%;
  justify-content: flex-start;
  gap: var(--s-2);
  height: 30px;
  font-size: var(--t-xs);
  border-color: var(--ok-edge);
  background: var(--ok-tint);
  color: var(--ok);
}
.update-btn:hover:not(:disabled) {
  background: var(--ok-tint);
  border-color: var(--ok);
}
.dot {
  margin-left: auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok);
}

.row-updating {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-2);
  border-radius: var(--r-sm);
  background: var(--info-tint);
  color: var(--info);
}

.version {
  text-align: center;
}
.err {
  line-height: 1.4;
}
</style>
