<script setup lang="ts">
/**
 * แก้ไข project fields ที่ PATCH /api/v1/projects/:id รองรับใน Phase 1
 * Source repository/branch ยังแก้ที่นี่ไม่ได้ — ต้องรอ repository picker ใน Phase 2
 */
export interface EditableProject {
  id: string;
  name: string;
  dockerfilePath: string;
  buildContext: string;
  internalPort: number | null;
  exposedPort: number | null;
  healthCheckPath: string | null;
  autoDeploy: boolean;
  mode?: "single" | "compose";
  linkNetwork?: string | null;
  archivedAt: number | null;
}

const props = defineProps<{ project: EditableProject }>();
const emit = defineEmits<{ saved: [] }>();

const api = useApi();
const { t } = useI18n();
const { isAdmin, canWrite } = usePermissions();

const form = reactive({
  name: "",
  dockerfilePath: "",
  buildContext: "",
  internalPort: "" as string,
  exposedPort: "" as string,
  healthCheckPath: "",
  autoDeploy: false,
  linkNetwork: "",
});

// ประกาศก่อน resetForm() เพราะ watch ด้านล่างเรียก resetForm ทันทีตอน setup
const fieldErrors = ref<Record<string, string>>({});
const saveError = ref("");
const saving = ref(false);
const saved = ref(false);

/**
 * โหลดค่าจาก project ปัจจุบันลงฟอร์ม
 * `keepStatus` ใช้ตอน props อัปเดตหลัง save สำเร็จ เพื่อไม่ให้ข้อความ "บันทึกแล้ว"
 * หายไปทันทีที่ parent refresh ข้อมูล
 */
function resetForm(keepStatus = false) {
  form.name = props.project.name;
  form.dockerfilePath = props.project.dockerfilePath;
  form.buildContext = props.project.buildContext;
  form.internalPort = props.project.internalPort === null ? "" : String(props.project.internalPort);
  form.exposedPort = props.project.exposedPort === null ? "" : String(props.project.exposedPort);
  form.healthCheckPath = props.project.healthCheckPath ?? "";
  form.autoDeploy = props.project.autoDeploy;
  form.linkNetwork = props.project.linkNetwork ?? "";
  fieldErrors.value = {};
  if (!keepStatus) {
    saveError.value = "";
    saved.value = false;
  }
}

/** ผู้ใช้กด "ยกเลิกการแก้ไข" — ล้างสถานะทั้งหมดรวมข้อความผลลัพธ์ */
function discardChanges() {
  resetForm();
}

watch(
  () => props.project,
  () => resetForm(saved.value),
  { immediate: true, deep: true },
);

const disabled = computed(() => props.project.archivedAt !== null);
/** แก้ไขไม่ได้: project ถูก archive หรือบัญชีเป็น viewer (API ตรวจสิทธิ์จริงอีกชั้น) */
const readOnly = computed(() => disabled.value || !canWrite.value);

const dirty = computed(
  () =>
    form.name !== props.project.name ||
    form.dockerfilePath !== props.project.dockerfilePath ||
    form.buildContext !== props.project.buildContext ||
    form.internalPort !==
      (props.project.internalPort === null ? "" : String(props.project.internalPort)) ||
    form.exposedPort !==
      (props.project.exposedPort === null ? "" : String(props.project.exposedPort)) ||
    form.healthCheckPath !== (props.project.healthCheckPath ?? "") ||
    form.autoDeploy !== props.project.autoDeploy ||
    form.linkNetwork !== (props.project.linkNetwork ?? ""),
);

const isCompose = computed(() => props.project.mode === "compose");

/** validate ฝั่ง client เพื่อ feedback เร็ว — API ยัง validate ซ้ำเสมอ */
function validate(): boolean {
  const errors: Record<string, string> = {};

  if (!form.name.trim()) errors.name = t("projects.settings.error.nameRequired");
  else if (form.name.trim().length > 100) errors.name = t("projects.settings.error.nameTooLong");

  if (!form.dockerfilePath.trim())
    errors.dockerfilePath = t("projects.settings.error.dockerfileRequired");
  if (!form.buildContext.trim()) errors.buildContext = t("projects.settings.error.contextRequired");

  for (const field of ["dockerfilePath", "buildContext"] as const) {
    const value = form[field].replaceAll("\\", "/");
    if (!value) continue;
    if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
      errors[field] = t("projects.settings.error.relativePath");
    } else if (value.split("/").includes("..")) {
      errors[field] = t("projects.settings.error.noParentDir");
    }
  }

  if (form.internalPort !== "") {
    const port = Number(form.internalPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.internalPort = t("projects.settings.error.portRange");
    }
  }

  if (form.exposedPort !== "") {
    const port = Number(form.exposedPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.exposedPort = t("projects.settings.error.portRange");
    } else if (form.internalPort === "") {
      errors.exposedPort = t("projects.settings.error.exposedNeedsInternal");
    }
  }

  const link = form.linkNetwork.trim();
  if (link !== "" && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(link)) {
    errors.linkNetwork = t("projects.settings.error.linkNetworkFormat");
  }

  fieldErrors.value = errors;
  return Object.keys(errors).length === 0;
}

// === นำเข้าจาก docker-compose.yml (Phase 13) — เติมฟอร์มเท่านั้น ไม่บันทึกอัตโนมัติ ===
const showComposeImport = ref(false);
const composeText = ref("");
const composeResult = ref<ReturnType<typeof parseComposeForBuildConfig> | null>(null);

function parseCompose() {
  composeResult.value = composeText.value.trim()
    ? parseComposeForBuildConfig(composeText.value)
    : { ok: false, error: t("projects.settings.pasteFirst") };
}

function applyComposeResult() {
  if (!composeResult.value?.ok) return;
  const { dockerfilePath, buildContext, internalPort } = composeResult.value.value;
  form.dockerfilePath = dockerfilePath;
  form.buildContext = buildContext;
  if (internalPort !== null) form.internalPort = String(internalPort);
  showComposeImport.value = false;
  composeText.value = "";
  composeResult.value = null;
}

async function save() {
  saved.value = false;
  saveError.value = "";
  if (!validate()) return;

  saving.value = true;
  try {
    const { error } = await api.api.v1.projects({ id: props.project.id }).patch({
      name: form.name.trim(),
      dockerfilePath: form.dockerfilePath.trim(),
      buildContext: form.buildContext.trim(),
      internalPort: form.internalPort === "" ? null : Number(form.internalPort),
      exposedPort: form.exposedPort === "" ? null : Number(form.exposedPort),
      healthCheckPath: form.healthCheckPath.trim() === "" ? null : form.healthCheckPath.trim(),
      autoDeploy: form.autoDeploy,
      // linkNetwork แก้ได้เฉพาะ admin — API ปฏิเสธถ้าคนอื่นส่งมา จึงไม่ใส่ใน body เลย
      ...(isCompose.value && isAdmin.value
        ? { linkNetwork: form.linkNetwork.trim() === "" ? null : form.linkNetwork.trim() }
        : {}),
    });

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
  <form class="settings stack" @submit.prevent="save">
    <p v-if="disabled" class="alert alert-warn">
      <AppIcon name="info" :size="15" />
      <span>{{ $t("projects.settings.archivedNote") }}</span>
    </p>

    <label>
      <span>{{ $t("projects.settings.name") }}</span>
      <input v-model="form.name" :disabled="readOnly" maxlength="100" />
      <em v-if="fieldErrors.name" class="field-error">{{ fieldErrors.name }}</em>
    </label>

    <div class="compose-import">
      <button
        type="button"
        class="ghost small"
        :disabled="readOnly"
        @click="showComposeImport = !showComposeImport"
      >
        <AppIcon :name="showComposeImport ? 'chevronDown' : 'chevronRight'" :size="13" />
        {{ $t("projects.settings.importCompose") }}
      </button>

      <div v-if="showComposeImport && !readOnly" class="compose-import-panel">
        <p class="muted small">
          <i18n-t scope="global" keypath="projects.settings.importHint" tag="span">
            <template #dockerfile><code>build.dockerfile</code></template>
            <template #context><code>build.context</code></template>
            <template #ports><code>ports:</code></template>
            <template #build><code>build:</code></template>
          </i18n-t>
        </p>
        <textarea
          v-model="composeText"
          rows="8"
          spellcheck="false"
          class="mono"
          placeholder="services:&#10;  web:&#10;    build:&#10;      context: .&#10;      dockerfile: Dockerfile&#10;    ports:&#10;      - &quot;8080:80&quot;"
        />
        <div class="actions-end">
          <button type="button" class="secondary small" @click="parseCompose">
            {{ $t("projects.settings.parse") }}
          </button>
        </div>

        <p v-if="composeResult && !composeResult.ok" class="alert alert-bad">
          <AppIcon name="alert" :size="15" />
          <span>{{ composeResult.error }}</span>
        </p>
        <template v-else-if="composeResult?.ok">
          <div class="inset compose-preview">
            <dl class="kv">
              <dt>Service</dt>
              <dd><code>{{ composeResult.value.serviceName }}</code></dd>
              <dt>Dockerfile path</dt>
              <dd><code>{{ composeResult.value.dockerfilePath }}</code></dd>
              <dt>Build context</dt>
              <dd><code>{{ composeResult.value.buildContext }}</code></dd>
              <dt>Internal port</dt>
              <dd>
                <code v-if="composeResult.value.internalPort">{{ composeResult.value.internalPort }}</code>
                <span v-else class="muted">{{ $t("projects.settings.portNotFound") }}</span>
              </dd>
            </dl>
          </div>
          <p v-for="w in composeResult.value.warnings" :key="w" class="alert alert-warn tiny">
            <AppIcon name="info" :size="14" />
            <span>{{ w }}</span>
          </p>
          <div class="actions-end">
            <button type="button" class="primary small" @click="applyComposeResult">
              {{ $t("projects.settings.applyParsed") }}
            </button>
          </div>
        </template>
      </div>
    </div>

    <label>
      <span>Dockerfile path</span>
      <input v-model="form.dockerfilePath" :disabled="readOnly" placeholder="Dockerfile" />
      <em v-if="fieldErrors.dockerfilePath" class="field-error">{{ fieldErrors.dockerfilePath }}</em>
    </label>

    <label>
      <span>Build context</span>
      <input v-model="form.buildContext" :disabled="readOnly" placeholder="." />
      <em v-if="fieldErrors.buildContext" class="field-error">{{ fieldErrors.buildContext }}</em>
    </label>

    <label>
      <span>{{ $t("projects.settings.internalPort") }}</span>
      <input v-model="form.internalPort" :disabled="readOnly" inputmode="numeric" placeholder="8080" />
      <em v-if="fieldErrors.internalPort" class="field-error">{{ fieldErrors.internalPort }}</em>
    </label>

    <label>
      <span>{{ $t("projects.settings.exposedPort") }}</span>
      <input v-model="form.exposedPort" :disabled="readOnly" inputmode="numeric" placeholder="3100" />
      <em v-if="fieldErrors.exposedPort" class="field-error">{{ fieldErrors.exposedPort }}</em>
      <em v-if="form.exposedPort !== '' && !fieldErrors.exposedPort" class="field-hint-inline">
        <i18n-t scope="global" keypath="projects.settings.exposedHint" tag="span">
          <template #address>
            <code>&lt;{{ $t("projects.settings.serverIp") }}&gt;:{{ form.exposedPort }}</code>
          </template>
          <template #port>{{ form.internalPort || "?" }}</template>
          <template #notNeeded>
            <strong>{{ $t("projects.settings.exposedHintNotNeeded") }}</strong>
          </template>
        </i18n-t>
      </em>
    </label>

    <label>
      <span>Health check path</span>
      <input v-model="form.healthCheckPath" :disabled="readOnly" placeholder="/healthz" />
    </label>

    <label v-if="isCompose">
      <span>{{ $t("projects.settings.linkNetwork") }}</span>
      <input
        v-model="form.linkNetwork"
        :disabled="readOnly || !isAdmin"
        maxlength="40"
        placeholder="sealand"
      />
      <em v-if="fieldErrors.linkNetwork" class="field-error">{{ fieldErrors.linkNetwork }}</em>
      <em v-else-if="form.linkNetwork.trim() !== ''" class="field-hint-inline">
        <i18n-t scope="global" keypath="projects.settings.linkNetworkHint" tag="span">
          <template #network>
            <code>zx-link-{{ form.linkNetwork.trim() }}</code>
          </template>
        </i18n-t>
      </em>
    </label>

    <div class="check-row">
      <input id="auto-deploy" v-model="form.autoDeploy" type="checkbox" :disabled="readOnly" />
      <label for="auto-deploy">{{ $t("projects.settings.autoDeploy") }}</label>
    </div>

    <p v-if="saveError" class="alert alert-bad">
      <AppIcon name="alert" :size="15" />
      <span>{{ saveError }}</span>
    </p>
    <p v-else-if="saved && !dirty" class="alert alert-ok">
      <AppIcon name="check" :size="15" />
      <span>{{ $t("common.saved") }}</span>
    </p>

    <div v-if="canWrite" class="actions-end form-footer">
      <button type="button" class="secondary" :disabled="disabled || !dirty || saving" @click="discardChanges">
        {{ $t("projects.settings.discard") }}
      </button>
      <button class="primary" type="submit" :disabled="disabled || !dirty || saving">
        <span v-if="saving" class="spinner" />
        {{ saving ? $t("common.saving") : $t("common.save") }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.settings label {
  margin-bottom: 0;
}
.field-error {
  display: block;
  margin-top: var(--s-2);
  font-style: normal;
  font-size: var(--t-xs);
  color: var(--bad);
}
.field-hint-inline {
  display: block;
  margin-top: var(--s-2);
  font-style: normal;
  font-size: var(--t-xs);
  color: var(--text-muted);
}
.form-footer {
  margin-top: var(--s-2);
  padding-top: var(--s-4);
  border-top: 1px solid var(--border-subtle);
}

.compose-import {
  margin-bottom: var(--s-2);
}
.compose-import-panel {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  margin-top: var(--s-3);
  padding: var(--s-3);
  background: var(--surface-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r);
}
.compose-import-panel textarea {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: var(--t-xs);
  line-height: 1.5;
  resize: vertical;
  min-height: 140px;
}
.compose-preview .kv {
  margin: 0;
}
</style>
