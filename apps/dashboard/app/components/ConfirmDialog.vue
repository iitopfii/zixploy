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
const typedInput = ref<HTMLInputElement | null>(null);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    typed.value = "";
    await nextTick();
    typedInput.value?.focus();
  },
);

const canConfirm = computed(
  () => !props.busy && (!props.requireTyped || typed.value === props.requireTyped),
);

/** Esc ปิด dialog — ผูกที่ document เพราะ focus อาจอยู่ที่ input ใน dialog */
onMounted(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && props.open && !props.busy) emit("cancel");
  };
  document.addEventListener("keydown", onKey);
  onUnmounted(() => document.removeEventListener("keydown", onKey));
});
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="open" class="backdrop" @click.self="!busy && emit('cancel')">
        <div class="dialog" role="alertdialog" aria-modal="true" :aria-label="title">
          <div class="dialog-head">
            <span class="warn-mark" aria-hidden="true">
              <AppIcon name="alert" :size="17" />
            </span>
            <div class="stack-sm">
              <h2>{{ title }}</h2>
              <p class="muted small">{{ message }}</p>
            </div>
          </div>

          <label v-if="requireTyped" class="confirm-field">
            <span>
              พิมพ์ <code>{{ requireTyped }}</code> เพื่อยืนยัน
            </span>
            <input
              ref="typedInput"
              v-model="typed"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              :disabled="busy"
              @keydown.enter.prevent="canConfirm && emit('confirm')"
            />
          </label>

          <div class="actions-end">
            <button class="secondary" :disabled="busy" @click="emit('cancel')">ยกเลิก</button>
            <button class="danger-solid" :disabled="!canConfirm" @click="emit('confirm')">
              <span v-if="busy" class="spinner" />
              {{ busy ? "กำลังดำเนินการ…" : (confirmLabel ?? "ยืนยัน") }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* .backdrop มาจาก main.css (global) — ห้ามนิยามซ้ำที่นี่ ดู comment ในไฟล์นั้น */

.dialog {
  width: 100%;
  max-width: 440px;
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  padding: var(--s-5);
  background: var(--surface-1);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-lg), var(--shadow-inset);
}

.dialog-head {
  display: flex;
  gap: var(--s-3);
}

.warn-mark {
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: var(--r);
  background: var(--bad-tint);
  border: 1px solid var(--bad-edge);
  color: var(--bad);
}

.dialog h2 {
  font-size: var(--t-md);
}

.confirm-field {
  margin: 0;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--fast);
}
.fade-enter-active .dialog,
.fade-leave-active .dialog {
  transition:
    transform var(--normal),
    opacity var(--normal);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.fade-enter-from .dialog,
.fade-leave-to .dialog {
  transform: translateY(8px) scale(0.98);
  opacity: 0;
}
</style>
