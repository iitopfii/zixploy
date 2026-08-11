<script setup lang="ts">
/**
 * Dockerfile-paste source (Phase 13) — วาง Dockerfile ตรง ๆ แทนการเชื่อม GitHub repository
 * ไม่มี git clone เลย — worker เขียนเนื้อหานี้ลง build context ตรง ๆ ก่อน build (ดู pipeline/build.ts)
 */
const props = defineProps<{
  projectId: string;
  initialContent: string | null;
  archived: boolean;
}>();

const emit = defineEmits<{ saved: [] }>();

const api = useApi();

const content = ref(props.initialContent ?? "");
const saveError = ref("");
const saving = ref(false);
const saved = ref(false);

watch(
  () => props.initialContent,
  (value) => {
    content.value = value ?? "";
  },
);

const isNew = computed(() => !props.initialContent);
const dirty = computed(() => content.value !== (props.initialContent ?? ""));
const byteSize = computed(() => new TextEncoder().encode(content.value).length);
const MAX_BYTES = 64 * 1024;
const tooLarge = computed(() => byteSize.value > MAX_BYTES);

function discard() {
  content.value = props.initialContent ?? "";
  saveError.value = "";
}

async function save() {
  saveError.value = "";
  saved.value = false;
  if (!content.value.trim()) {
    saveError.value = "ต้องวางเนื้อหา Dockerfile";
    return;
  }
  if (tooLarge.value) {
    saveError.value = `เนื้อหาใหญ่เกิน ${MAX_BYTES / 1024}KB`;
    return;
  }

  saving.value = true;
  try {
    const { error } = await api.api.v1
      .projects({ id: props.projectId })
      .source.dockerfile.post({ dockerfile: content.value });
    if (error) {
      const body = error.value as { error?: { message?: string } } | null;
      saveError.value = body?.error?.message ?? "บันทึกไม่สำเร็จ";
      return;
    }
    saved.value = true;
    emit("saved");
  } catch {
    saveError.value = "ติดต่อ API ไม่ได้";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="stack">
    <p class="muted small">
      วาง Dockerfile ตรง ๆ แทนการเชื่อม repository — ระบบจะ build จากเนื้อหานี้ทุกครั้งที่ deploy
      โดยไม่มีการ git clone เลย เหมาะกับโปรเจกต์เล็ก ๆ ที่ไม่มี repo หรืออยากทดลองเร็ว ๆ
    </p>

    <label>
      <span>เนื้อหา Dockerfile</span>
      <textarea
        v-model="content"
        :disabled="archived"
        rows="14"
        spellcheck="false"
        class="mono"
        placeholder="FROM node:20-alpine&#10;WORKDIR /app&#10;COPY . .&#10;RUN npm install&#10;CMD [&quot;node&quot;, &quot;index.js&quot;]"
      />
      <em class="char-count" :class="{ warn: tooLarge }">
        {{ byteSize.toLocaleString() }} / {{ (MAX_BYTES / 1024).toFixed(0) }}KB
      </em>
    </label>

    <p v-if="saveError" class="alert alert-bad">
      <AppIcon name="alert" :size="15" />
      <span>{{ saveError }}</span>
    </p>
    <p v-else-if="saved && !dirty" class="alert alert-ok">
      <AppIcon name="check" :size="15" />
      <span>บันทึกแล้ว</span>
    </p>

    <div class="actions-end">
      <button
        v-if="!isNew"
        type="button"
        class="secondary"
        :disabled="archived || !dirty || saving"
        @click="discard"
      >
        ยกเลิกการแก้ไข
      </button>
      <button class="primary" :disabled="archived || !dirty || saving" @click="save">
        <span v-if="saving" class="spinner" />
        {{ saving ? "กำลังบันทึก…" : isNew ? "ใช้เป็น source" : "บันทึก" }}
      </button>
    </div>
  </div>
</template>

<style scoped>
textarea.mono {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: var(--t-sm);
  line-height: 1.5;
  resize: vertical;
  min-height: 220px;
}
.char-count {
  display: block;
  margin-top: var(--s-2);
  font-style: normal;
  font-size: var(--t-xs);
  color: var(--text-faint);
}
.char-count.warn {
  color: var(--bad);
}
</style>
