<script setup lang="ts">
/** Confirmation สำหรับ destructive action (docs/phase-01) */
const props = defineProps<{
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  /** ถ้ากำหนด ผู้ใช้ต้องพิมพ์ข้อความนี้ให้ตรงก่อนจึงยืนยันได้ */
  requireTyped?: string;
  busy?: boolean;
}>();

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const typed = ref("");
watch(
  () => props.open,
  (open) => {
    if (open) typed.value = "";
  },
);

const canConfirm = computed(
  () => !props.busy && (!props.requireTyped || typed.value === props.requireTyped),
);
</script>

<template>
  <div v-if="open" class="backdrop" @click.self="emit('cancel')">
    <div class="card dialog" role="dialog" aria-modal="true">
      <h2>{{ title }}</h2>
      <p class="muted">{{ message }}</p>

      <label v-if="requireTyped">
        <span>พิมพ์ <code>{{ requireTyped }}</code> เพื่อยืนยัน</span>
        <input v-model="typed" autocomplete="off" />
      </label>

      <div class="actions">
        <button :disabled="busy" @click="emit('cancel')">ยกเลิก</button>
        <button class="danger" :disabled="!canConfirm" @click="emit('confirm')">
          {{ busy ? "กำลังดำเนินการ…" : (confirmLabel ?? "ยืนยัน") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 60%);
  display: grid;
  place-items: center;
  padding: 1.5rem;
  z-index: 50;
}
.dialog {
  max-width: 420px;
  width: 100%;
}
h2 {
  margin: 0 0 0.5rem;
  font-size: 1.05rem;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 1.25rem;
}
</style>
