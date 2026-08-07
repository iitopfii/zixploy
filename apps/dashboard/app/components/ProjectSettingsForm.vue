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

  fieldErrors.value = errors;
  return Object.keys(errors).length === 0;
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
.form-footer {
  margin-top: var(--s-2);
  padding-top: var(--s-4);
  border-top: 1px solid var(--border-subtle);
}
</style>
