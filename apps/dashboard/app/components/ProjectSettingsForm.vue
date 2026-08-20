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
  archivedAt: number | null;
}

const props = defineProps<{ project: EditableProject }>();
const emit = defineEmits<{ saved: [] }>();

const api = useApi();

const form = reactive({
  name: "",
  dockerfilePath: "",
  buildContext: "",
  internalPort: "" as string,
  exposedPort: "" as string,
  healthCheckPath: "",
  autoDeploy: false,
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
    form.autoDeploy !== props.project.autoDeploy,
);

/** validate ฝั่ง client เพื่อ feedback เร็ว — API ยัง validate ซ้ำเสมอ */
function validate(): boolean {
  const errors: Record<string, string> = {};

  if (!form.name.trim()) errors.name = "ต้องระบุชื่อ project";
  else if (form.name.trim().length > 100) errors.name = "ชื่อยาวเกิน 100 ตัวอักษร";

  if (!form.dockerfilePath.trim()) errors.dockerfilePath = "ต้องระบุ Dockerfile path";
  if (!form.buildContext.trim()) errors.buildContext = "ต้องระบุ build context";

  for (const field of ["dockerfilePath", "buildContext"] as const) {
    const value = form[field].replaceAll("\\", "/");
    if (!value) continue;
    if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
      errors[field] = "ต้องเป็น relative path";
    } else if (value.split("/").includes("..")) {
      errors[field] = 'ต้องไม่มี ".."';
    }
  }

  if (form.internalPort !== "") {
    const port = Number(form.internalPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.internalPort = "port ต้องเป็นจำนวนเต็มระหว่าง 1–65535";
    }
  }

  if (form.exposedPort !== "") {
    const port = Number(form.exposedPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.exposedPort = "port ต้องเป็นจำนวนเต็มระหว่าง 1–65535";
    } else if (form.internalPort === "") {
      errors.exposedPort = "ต้องระบุ internal port ก่อนจึงจะ expose port ออก host ได้";
    }
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
    : { ok: false, error: "วางเนื้อหา docker-compose.yml ก่อน" };
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
    });

    if (error) {
      const body = error.value as { error?: { code?: string; message?: string } } | null;
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
  <form class="settings stack" @submit.prevent="save">
    <p v-if="disabled" class="alert alert-warn">
      <AppIcon name="info" :size="15" />
      <span>project ถูก archive แล้ว — แก้ไขไม่ได้</span>
    </p>

    <label>
      <span>ชื่อ project</span>
      <input v-model="form.name" :disabled="disabled" maxlength="100" />
      <em v-if="fieldErrors.name" class="field-error">{{ fieldErrors.name }}</em>
    </label>

    <div class="compose-import">
      <button
        type="button"
        class="ghost small"
        :disabled="disabled"
        @click="showComposeImport = !showComposeImport"
      >
        <AppIcon :name="showComposeImport ? 'chevronDown' : 'chevronRight'" :size="13" />
        นำเข้าจาก docker-compose.yml
      </button>

      <div v-if="showComposeImport" class="compose-import-panel">
        <p class="muted small">
          วางเนื้อหา docker-compose.yml — ระบบจะดึง <code>build.dockerfile</code>,
          <code>build.context</code> และ port แรกใน <code>ports:</code> จาก service แรกที่มี
          <code>build:</code> มาเติมให้ (ใช้ได้ 1 container ต่อ project เท่านั้น)
        </p>
        <textarea
          v-model="composeText"
          rows="8"
          spellcheck="false"
          class="mono"
          placeholder="services:&#10;  web:&#10;    build:&#10;      context: .&#10;      dockerfile: Dockerfile&#10;    ports:&#10;      - &quot;8080:80&quot;"
        />
        <div class="actions-end">
          <button type="button" class="secondary small" @click="parseCompose">แยกค่า</button>
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
                <span v-else class="muted">ไม่พบ — ต้องระบุเอง</span>
              </dd>
            </dl>
          </div>
          <p v-for="w in composeResult.value.warnings" :key="w" class="alert alert-warn tiny">
            <AppIcon name="info" :size="14" />
            <span>{{ w }}</span>
          </p>
          <div class="actions-end">
            <button type="button" class="primary small" @click="applyComposeResult">
              ใช้ค่านี้เติมฟอร์ม
            </button>
          </div>
        </template>
      </div>
    </div>

    <label>
      <span>Dockerfile path</span>
      <input v-model="form.dockerfilePath" :disabled="disabled" placeholder="Dockerfile" />
      <em v-if="fieldErrors.dockerfilePath" class="field-error">{{ fieldErrors.dockerfilePath }}</em>
    </label>

    <label>
      <span>Build context</span>
      <input v-model="form.buildContext" :disabled="disabled" placeholder="." />
      <em v-if="fieldErrors.buildContext" class="field-error">{{ fieldErrors.buildContext }}</em>
    </label>

    <label>
      <span>Internal port (ว่างไว้ได้ถ้ายังไม่กำหนด)</span>
      <input v-model="form.internalPort" :disabled="disabled" inputmode="numeric" placeholder="8080" />
      <em v-if="fieldErrors.internalPort" class="field-error">{{ fieldErrors.internalPort }}</em>
    </label>

    <label>
      <span>Exposed port — เปิด port บนเครื่อง server ให้เข้าถึง container ตรง ๆ (ว่าง = ผ่าน domain เท่านั้น)</span>
      <input v-model="form.exposedPort" :disabled="disabled" inputmode="numeric" placeholder="3100" />
      <em v-if="fieldErrors.exposedPort" class="field-error">{{ fieldErrors.exposedPort }}</em>
      <em v-if="form.exposedPort !== '' && !fieldErrors.exposedPort" class="field-hint-inline">
        เข้าถึงได้ที่ <code>&lt;IP เซิร์ฟเวอร์&gt;:{{ form.exposedPort }}</code> → container:{{ form.internalPort || "?" }}
        — deploy ครั้งถัดไปจะมี downtime สั้น ๆ ระหว่างสลับ container (host port ผูกได้ทีละตัว)
        · ถ้าเข้าใช้งานผ่าน domain (Traefik) อยู่แล้ว <strong>ไม่จำเป็นต้องตั้งค่านี้</strong> —
        เว้นว่างไว้ deploy จะไม่มี downtime และระบบคืนเวอร์ชันเก่าให้อัตโนมัติเมื่อ deploy ล้มเหลว
        (ตั้ง port นี้แล้วจะเสียกลไกกู้คืนอัตโนมัตินั้นไป)
      </em>
    </label>

    <label>
      <span>Health check path</span>
      <input v-model="form.healthCheckPath" :disabled="disabled" placeholder="/healthz" />
    </label>

    <div class="check-row">
      <input id="auto-deploy" v-model="form.autoDeploy" type="checkbox" :disabled="disabled" />
      <label for="auto-deploy">Auto deploy เมื่อมี push (ทำงานจริงเมื่อเชื่อม repository)</label>
    </div>

    <p v-if="saveError" class="alert alert-bad">
      <AppIcon name="alert" :size="15" />
      <span>{{ saveError }}</span>
    </p>
    <p v-else-if="saved && !dirty" class="alert alert-ok">
      <AppIcon name="check" :size="15" />
      <span>บันทึกแล้ว</span>
    </p>

    <div class="actions-end form-footer">
      <button type="button" class="secondary" :disabled="disabled || !dirty || saving" @click="discardChanges">
        ยกเลิกการแก้ไข
      </button>
      <button class="primary" type="submit" :disabled="disabled || !dirty || saving">
        <span v-if="saving" class="spinner" />
        {{ saving ? "กำลังบันทึก…" : "บันทึก" }}
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
