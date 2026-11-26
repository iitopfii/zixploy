<script setup lang="ts">
/**
 * สลับภาษา ไทย/อังกฤษ — ค่าที่เลือกเก็บในคุกกี้ zx_locale (nuxt.config.ts)
 * Control API อ่านคุกกี้เดียวกัน ข้อความ error จึงเปลี่ยนภาษาตามไปด้วย
 */
const { locale, locales, setLocale } = useI18n();

const options = computed(() =>
  locales.value.map((l) => ({ code: l.code, name: l.name ?? l.code })),
);
</script>

<template>
  <div class="locale-switch" role="group" :aria-label="$t('common.language')">
    <button
      v-for="option in options"
      :key="option.code"
      type="button"
      class="locale-option"
      :class="{ active: option.code === locale }"
      :aria-pressed="option.code === locale"
      :lang="option.code"
      @click="setLocale(option.code)"
    >
      {{ option.name }}
    </button>
  </div>
</template>

<style scoped>
.locale-switch {
  display: inline-flex;
  padding: 2px;
  gap: 2px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--r);
  background: var(--bg);
}

.locale-option {
  flex: 1;
  min-height: 0;
  padding: 3px 10px;
  border: 0;
  border-radius: calc(var(--r) - 2px);
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
  cursor: pointer;
}

.locale-option:hover {
  color: var(--text);
}

.locale-option.active {
  background: var(--surface-2, var(--bg-subtle));
  color: var(--text);
}
</style>
