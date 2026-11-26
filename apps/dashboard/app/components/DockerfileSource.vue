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
const { t } = useI18n();
const { canWrite } = usePermissions();

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
    saveError.value = t("components.dockerfile.error.empty");
    return;
  }
  if (tooLarge.value) {
    saveError.value = t("components.dockerfile.error.tooLarge", { n: MAX_BYTES / 1024 });
    return;
  }

  saving.value = true;
  try {
    const { error } = await api.api.v1
      .projects({ id: props.projectId })
      .source.dockerfile.post({ dockerfile: content.value });
    if (error) {
      saveError.value = apiErrorMessage(error, "common.saveFailed");
      return;
    }
    saved.value = true;
    emit("saved");
  } catch {
    saveError.value = t("common.apiUnreachable");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="stack">
    <p class="muted small">
      {{ $t("components.dockerfile.intro") }}
    </p>

    <label>
      <span>{{ $t("components.dockerfile.label") }}</span>
      <textarea
        v-model="content"
        :disabled="archived || !canWrite"
        rows="14"
        spellcheck="false"
        class="mono"
        placeholder="FROM node:20-alpine&#10;WORKDIR /app&#10;COPY . .&#10;RUN npm install&#10;CMD [&quot;node&quot;, &quot;index.js&quot;]"
      />
      <em class="char-count" :class="{ warn: tooLarge }">
        {{ byteSize.toLocaleString(localeTag()) }} / {{ (MAX_BYTES / 1024).toFixed(0) }}KB
      </em>
    </label>

    <p v-if="saveError" class="alert alert-bad">
      <AppIcon name="alert" :size="15" />
      <span>{{ saveError }}</span>
    </p>
    <p v-else-if="saved && !dirty" class="alert alert-ok">
      <AppIcon name="check" :size="15" />
      <span>{{ $t("common.saved") }}</span>
    </p>

    <div v-if="canWrite" class="actions-end">
      <button
        v-if="!isNew"
        type="button"
        class="secondary"
        :disabled="archived || !dirty || saving"
        @click="discard"
      >
        {{ $t("components.dockerfile.discard") }}
      </button>
      <button class="primary" :disabled="archived || !dirty || saving" @click="save">
        <span v-if="saving" class="spinner" />
        {{
          saving
            ? $t("common.saving")
            : isNew
              ? $t("components.dockerfile.useAsSource")
              : $t("common.save")
        }}
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
