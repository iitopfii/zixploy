<script setup lang="ts">
/**
 * Components Tab — multi-container (compose-style) projects, Phase 18 · C3
 *
 * แก้ไข project_components ผ่าน CRUD ทีละตัว (ไม่ใช่ bulk PUT เหมือน env) แล้ว "promote"
 * โปรเจกต์เป็น mode='compose' เมื่อพร้อม (มี ≥1 component + ≥1 web) — deploy ครั้งถัดไปจะวิ่ง
 * multi-container orchestrator แทน pipeline เดิม
 *
 * ADR-0002: หน้านี้แค่เขียน config ผ่าน API — worker เป็นฝ่ายเอาไปสร้าง container จริง
 */
const props = defineProps<{ projectId: string; archived: boolean; mode: "single" | "compose" }>();
const emit = defineEmits<{ changed: [] }>();

const api = useApi();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ComponentDep {
  componentId: string;
  name: string;
  condition: "started" | "healthy";
}

interface Component {
  id: string;
  name: string;
  role: "web" | "worker" | "db" | "cache" | "app" | "other";
  sourceKind: "build" | "image" | "managed_ref";
  dockerfilePath: string | null;
  buildContext: string | null;
  targetStage: string | null;
  imageRef: string | null;
  managedServiceId: string | null;
  command: string | null;
  internalPort: number | null;
  isWeb: boolean;
  webPort: number | null;
  healthCheckPath: string | null;
  healthCmd: string | null;
  cpuLimit: number | null;
  memoryLimitMb: number | null;
  restartPolicy: string;
  position: number;
  enabled: boolean;
  dependsOn: ComponentDep[];
}

interface ServiceOption {
  id: string;
  name: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Load components + services (managed_ref dropdown)
// ---------------------------------------------------------------------------

const components = ref<Component[]>([]);
const services = ref<ServiceOption[]>([]);
const loading = ref(true);
const loadError = ref("");

async function fetchComponents() {
  loadError.value = "";
  try {
    const { data, error } = await api.api.v1.projects({ id: props.projectId }).components.get();
    if (error) {
      loadError.value = "โหลด components ไม่ได้";
      return;
    }
    components.value = (data?.items ?? []) as Component[];
  } catch {
    loadError.value = "ติดต่อ API ไม่ได้";
  } finally {
    loading.value = false;
  }
}

async function fetchServices() {
  try {
    const { data } = await api.api.v1.services.get();
    services.value = (data?.items ?? []).map((s) => ({ id: s.id, name: s.name, type: s.type }));
  } catch {
    // ไม่ critical — managed_ref dropdown จะว่างถ้าโหลด services ไม่ได้
  }
}

await Promise.all([fetchComponents(), fetchServices()]);

// ---------------------------------------------------------------------------
// Form (create / edit shared)
// ---------------------------------------------------------------------------

type FormMode = "create" | "edit" | null;
const formMode = ref<FormMode>(null);
const editingId = ref<string | null>(null);
const formError = ref("");
const saving = ref(false);

const blankForm = () => ({
  name: "",
  role: "app" as Component["role"],
  sourceKind: "build" as Component["sourceKind"],
  dockerfilePath: "Dockerfile",
  buildContext: ".",
  targetStage: "",
  imageRef: "",
  managedServiceId: "",
  command: "",
  internalPort: "",
  isWeb: false,
  webPort: "",
  healthCheckPath: "",
  healthCmd: "",
  cpuLimit: "",
  memoryLimitMb: "",
  restartPolicy: "unless-stopped" as string,
});
const form = reactive(blankForm());

/** dependency ที่เลือกไว้ในฟอร์ม: name → condition (ไม่มี key = ไม่ได้เลือก) */
const depSelections = reactive<Record<string, "started" | "healthy">>({});

/** component อื่นให้เลือกเป็น dependency (ยกเว้นตัวที่กำลังแก้เอง) */
const dependableComponents = computed(() =>
  components.value.filter((c) => c.id !== editingId.value),
);

function resetForm() {
  Object.assign(form, blankForm());
  for (const k of Object.keys(depSelections)) delete depSelections[k];
  formError.value = "";
}

function openCreate() {
  editingId.value = null;
  resetForm();
  formMode.value = "create";
}

function openEdit(c: Component) {
  editingId.value = c.id;
  resetForm();
  Object.assign(form, {
    name: c.name,
    role: c.role,
    sourceKind: c.sourceKind,
    dockerfilePath: c.dockerfilePath ?? "Dockerfile",
    buildContext: c.buildContext ?? ".",
    targetStage: c.targetStage ?? "",
    imageRef: c.imageRef ?? "",
    managedServiceId: c.managedServiceId ?? "",
    command: c.command ?? "",
    healthCmd: c.healthCmd ?? "",
    internalPort: c.internalPort != null ? String(c.internalPort) : "",
    isWeb: c.isWeb,
    webPort: c.webPort != null ? String(c.webPort) : "",
    healthCheckPath: c.healthCheckPath ?? "",
    cpuLimit: c.cpuLimit != null ? String(c.cpuLimit) : "",
    memoryLimitMb: c.memoryLimitMb != null ? String(c.memoryLimitMb) : "",
    restartPolicy: c.restartPolicy,
  });
  for (const d of c.dependsOn) depSelections[d.name] = d.condition;
  formMode.value = "edit";
}

function closeForm() {
  formMode.value = null;
  editingId.value = null;
  resetForm();
}

function toggleDep(name: string, checked: boolean) {
  if (checked) depSelections[name] = depSelections[name] ?? "started";
  else delete depSelections[name];
}

/** "" → null, ไม่งั้นเป็น Number (ให้ API validate ช่วงค่าเอง) */
function toNum(s: string): number | null {
  const t = s.trim();
  return t === "" ? null : Number(t);
}

function buildPayload() {
  const dependsOn = Object.entries(depSelections).map(([name, condition]) => ({ name, condition }));
  const common = {
    name: form.name.trim(),
    role: form.role,
    command: form.command.trim() === "" ? null : form.command,
    restartPolicy: form.restartPolicy as "no" | "on-failure" | "always" | "unless-stopped",
    dependsOn,
  };

  // managed_ref = อ้าง service เท่านั้น ไม่มี runtime config ของตัวเอง (worker verify ว่ารันอยู่)
  if (form.sourceKind === "managed_ref") {
    return {
      ...common,
      managedServiceId: form.managedServiceId || null,
    };
  }

  const runtime = {
    ...common,
    internalPort: toNum(form.internalPort),
    isWeb: form.isWeb,
    webPort: form.isWeb ? toNum(form.webPort) : null,
    healthCheckPath: form.healthCheckPath.trim() === "" ? null : form.healthCheckPath.trim(),
    healthCmd: form.healthCmd.trim() === "" ? null : form.healthCmd.trim(),
    cpuLimit: toNum(form.cpuLimit),
    memoryLimitMb: toNum(form.memoryLimitMb),
  };

  if (form.sourceKind === "build") {
    return {
      ...runtime,
      dockerfilePath: form.dockerfilePath.trim() || "Dockerfile",
      buildContext: form.buildContext.trim() || ".",
      targetStage: form.targetStage.trim() === "" ? null : form.targetStage.trim(),
    };
  }
  // image
  return { ...runtime, imageRef: form.imageRef.trim() };
}

async function submitForm() {
  saving.value = true;
  formError.value = "";
  try {
    const payload = buildPayload();
    if (formMode.value === "create") {
      const { error } = await api.api.v1
        .projects({ id: props.projectId })
        .components.post({ ...payload, sourceKind: form.sourceKind });
      if (error) {
        formError.value = apiMessage(error) ?? "เพิ่ม component ไม่สำเร็จ";
        return;
      }
    } else if (editingId.value) {
      const { error } = await api.api.v1
        .projects({ id: props.projectId })
        .components({ componentId: editingId.value })
        .patch(payload);
      if (error) {
        formError.value = apiMessage(error) ?? "บันทึกไม่สำเร็จ";
        return;
      }
    }
    closeForm();
    await fetchComponents();
  } catch {
    formError.value = "ติดต่อ API ไม่ได้";
  } finally {
    saving.value = false;
  }
}

// ---------------------------------------------------------------------------
// Enable toggle + delete
// ---------------------------------------------------------------------------

const togglingId = ref<string | null>(null);

async function toggleEnabled(c: Component) {
  togglingId.value = c.id;
  try {
    await api.api.v1
      .projects({ id: props.projectId })
      .components({ componentId: c.id })
      .patch({ enabled: !c.enabled });
    await fetchComponents();
  } finally {
    togglingId.value = null;
  }
}

const confirmDeleteId = ref<string | null>(null);
const deleting = ref(false);
const deleteError = ref("");

async function removeComponent(id: string) {
  deleting.value = true;
  deleteError.value = "";
  try {
    const { error } = await api.api.v1
      .projects({ id: props.projectId })
      .components({ componentId: id })
      .delete();
    if (error) {
      deleteError.value = apiMessage(error) ?? "ลบไม่สำเร็จ";
      return;
    }
    confirmDeleteId.value = null;
    await fetchComponents();
  } catch {
    deleteError.value = "ติดต่อ API ไม่ได้";
  } finally {
    deleting.value = false;
  }
}

// ---------------------------------------------------------------------------
// Promote to compose
// ---------------------------------------------------------------------------

const promoting = ref(false);
const promoteError = ref("");

const webCount = computed(() => components.value.filter((c) => c.isWeb).length);
const canPromote = computed(() => components.value.length > 0 && webCount.value > 0);

async function promote() {
  promoting.value = true;
  promoteError.value = "";
  try {
    const { error } = await api.api.v1.projects({ id: props.projectId }).compose.promote.post();
    if (error) {
      promoteError.value = apiMessage(error) ?? "เปลี่ยนเป็น compose ไม่สำเร็จ";
      return;
    }
    await fetchComponents();
    emit("changed"); // ให้ parent refresh project เพื่ออัปเดต mode badge
  } catch {
    promoteError.value = "ติดต่อ API ไม่ได้";
  } finally {
    promoting.value = false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apiMessage(error: unknown): string | undefined {
  return (error as { value?: { error?: { message?: string } } } | null)?.value?.error?.message;
}

const ROLE_TONE: Record<string, string> = {
  web: "tone-ok",
  worker: "tone-idle",
  db: "tone-warn",
  cache: "tone-warn",
};
function roleTone(role: string) {
  return ROLE_TONE[role] ?? "tone-idle";
}

const SOURCE_LABEL: Record<string, string> = {
  build: "Build",
  image: "Image",
  managed_ref: "Database",
};

function sourceSummary(c: Component): string {
  if (c.sourceKind === "build")
    return `${c.buildContext ?? "."} · ${c.dockerfilePath ?? "Dockerfile"}`;
  if (c.sourceKind === "image") return c.imageRef ?? "—";
  const svc = services.value.find((s) => s.id === c.managedServiceId);
  return svc ? `${svc.name} (${svc.type})` : "managed database";
}
</script>

<template>
  <div class="stack-lg">
    <div class="row-between wrap">
      <div class="stack-sm">
        <h2 class="section-title">Components</h2>
        <p class="muted small">
          รันหลาย container ต่อโปรเจกต์ (เว็บ + worker + database) แบบ compose
        </p>
      </div>
      <span class="badge" :class="mode === 'compose' ? 'tone-ok' : 'tone-idle'">
        โหมด: {{ mode === "compose" ? "compose (multi-container)" : "single container" }}
      </span>
    </div>

    <!-- single-mode intro -->
    <div v-if="mode === 'single'" class="alert alert-warn">
      <AppIcon name="info" :size="16" />
      <div class="stack-sm">
        <strong>โปรเจกต์นี้ยังรันแบบ container เดียว</strong>
        <span class="muted small">
          กำหนด component ด้านล่างให้ครบ (ต้องมีอย่างน้อย 1 ตัวที่เป็น web) แล้วกด
          "เปลี่ยนเป็น compose" — deploy ครั้งถัดไปจะรันแบบหลาย container
        </span>
      </div>
    </div>

    <div v-if="loading" class="stack">
      <span class="skeleton" style="height: 90px" />
      <span class="skeleton" style="height: 90px" />
    </div>
    <p v-else-if="loadError" class="alert alert-bad">
      <AppIcon name="alert" :size="15" />
      <span>{{ loadError }}</span>
    </p>

    <template v-else>
      <!-- Component list -->
      <div v-if="components.length === 0 && formMode !== 'create'" class="empty">
        <span class="empty-icon"><AppIcon name="box" :size="20" /></span>
        <span class="empty-title">ยังไม่มี component</span>
        <p class="small">เพิ่ม component แรก (เช่น เว็บแอปของคุณ) เพื่อเริ่มต้น</p>
      </div>

      <ul v-else-if="components.length > 0" class="cmp-list">
        <li v-for="c in components" :key="c.id" class="inset cmp-item" :class="{ off: !c.enabled }">
          <div class="cmp-header">
            <strong class="mono">{{ c.name }}</strong>
            <span class="badge" :class="roleTone(c.role)">{{ c.role }}</span>
            <span class="badge">{{ SOURCE_LABEL[c.sourceKind] }}</span>
            <span v-if="c.isWeb" class="badge tone-ok">web · :{{ c.webPort ?? "?" }}</span>
            <span v-if="!c.enabled" class="badge tone-idle">ปิดใช้งาน</span>
          </div>

          <dl class="kv">
            <dt>Source</dt>
            <dd><code class="small">{{ sourceSummary(c) }}</code></dd>
            <template v-if="c.internalPort != null">
              <dt>Internal port</dt>
              <dd><code>{{ c.internalPort }}</code></dd>
            </template>
            <template v-if="c.dependsOn.length > 0">
              <dt>Depends on</dt>
              <dd class="dep-chips">
                <span v-for="d in c.dependsOn" :key="d.componentId" class="dep-chip">
                  {{ d.name }}
                  <span class="muted tiny">({{ d.condition }})</span>
                </span>
              </dd>
            </template>
          </dl>

          <div v-if="!archived" class="cmp-actions">
            <button class="secondary small" @click="openEdit(c)">
              <AppIcon name="settings" :size="13" />
              แก้ไข
            </button>
            <button
              class="secondary small"
              :disabled="togglingId === c.id"
              @click="toggleEnabled(c)"
            >
              <span v-if="togglingId === c.id" class="spinner" />
              {{ c.enabled ? "ปิดใช้งาน" : "เปิดใช้งาน" }}
            </button>
            <button class="danger small" @click="confirmDeleteId = c.id; deleteError = ''">
              <AppIcon name="trash" :size="13" />
              ลบ
            </button>
          </div>

          <!-- inline delete confirm -->
          <div v-if="confirmDeleteId === c.id" class="confirm-delete">
            <p class="warn-text small">ลบ component <strong>{{ c.name }}</strong>? (ลบแค่นิยาม ไม่ลบข้อมูล)</p>
            <p v-if="deleteError" class="alert alert-bad small">
              <AppIcon name="alert" :size="13" />
              <span>{{ deleteError }}</span>
            </p>
            <div class="confirm-actions">
              <button class="danger small" :disabled="deleting" @click="removeComponent(c.id)">
                <span v-if="deleting" class="spinner" />
                {{ deleting ? "กำลังลบ…" : "ยืนยันลบ" }}
              </button>
              <button class="secondary small" @click="confirmDeleteId = null">ยกเลิก</button>
            </div>
          </div>
        </li>
      </ul>

      <!-- Add button -->
      <div v-if="!archived && formMode === null">
        <button class="primary small" @click="openCreate">
          <AppIcon name="plus" :size="14" />
          เพิ่ม component
        </button>
      </div>

      <!-- Create/Edit form -->
      <div v-if="formMode !== null" class="inset stack cmp-form">
        <h3 class="form-title">{{ formMode === "create" ? "เพิ่ม component" : `แก้ไข ${form.name}` }}</h3>

        <div class="form-grid">
          <label>
            <span>ชื่อ (DNS alias)</span>
            <input v-model="form.name" class="mono" placeholder="web, api, cache" :disabled="formMode === 'edit'" />
            <small class="muted">a-z, 0-9, ขีดกลาง — ใช้เป็นชื่อให้ container อื่นเรียกถึง</small>
          </label>
          <label>
            <span>ประเภท (role)</span>
            <select v-model="form.role">
              <option value="web">web</option>
              <option value="worker">worker</option>
              <option value="db">db</option>
              <option value="cache">cache</option>
              <option value="app">app</option>
              <option value="other">other</option>
            </select>
          </label>
        </div>

        <label>
          <span>ที่มาของ image</span>
          <select v-model="form.sourceKind" :disabled="formMode === 'edit'">
            <option value="build">Build จาก Dockerfile</option>
            <option value="image">Image สำเร็จรูป (registry)</option>
            <option value="managed_ref">อ้าง managed database</option>
          </select>
          <small v-if="formMode === 'edit'" class="muted">เปลี่ยนที่มาไม่ได้หลังสร้าง — ลบแล้วสร้างใหม่</small>
        </label>

        <!-- build fields -->
        <div v-if="form.sourceKind === 'build'" class="form-grid">
          <label>
            <span>Dockerfile path</span>
            <input v-model="form.dockerfilePath" class="mono" placeholder="Dockerfile" />
          </label>
          <label>
            <span>Build context</span>
            <input v-model="form.buildContext" class="mono" placeholder="." />
          </label>
          <label>
            <span>Target stage (ไม่บังคับ)</span>
            <input v-model="form.targetStage" class="mono" placeholder="production" />
          </label>
        </div>

        <!-- image field -->
        <label v-if="form.sourceKind === 'image'">
          <span>Image reference</span>
          <input v-model="form.imageRef" class="mono" placeholder="redis:7-alpine" />
          <small class="muted">ต้องระบุ tag หรือ digest — ห้ามใช้ latest</small>
        </label>

        <!-- managed_ref field -->
        <label v-if="form.sourceKind === 'managed_ref'">
          <span>Managed database</span>
          <select v-model="form.managedServiceId">
            <option value="">— เลือก service —</option>
            <option v-for="s in services" :key="s.id" :value="s.id">{{ s.name }} ({{ s.type }})</option>
          </select>
          <small v-if="services.length === 0" class="muted">
            ยังไม่มี managed database — สร้างที่หน้า Databases ก่อน
          </small>
        </label>

        <!-- runtime fields (build/image only) -->
        <template v-if="form.sourceKind !== 'managed_ref'">
          <div class="check-row">
            <input id="cmp-isweb" v-model="form.isWeb" type="checkbox" />
            <label for="cmp-isweb">เป็น web (public) — route ผ่าน domain ของโปรเจกต์</label>
          </div>

          <div class="form-grid">
            <label v-if="form.isWeb">
              <span>Web port</span>
              <input v-model="form.webPort" class="mono" placeholder="3000" inputmode="numeric" />
            </label>
            <label>
              <span>Internal port (สำหรับ health check)</span>
              <input v-model="form.internalPort" class="mono" placeholder="3000" inputmode="numeric" />
            </label>
            <label>
              <span>Health check path (ไม่บังคับ)</span>
              <input v-model="form.healthCheckPath" class="mono" placeholder="/health" />
            </label>
          </div>

          <label>
            <span>Health command (ไม่บังคับ)</span>
            <input v-model="form.healthCmd" class="mono" placeholder="redis-cli ping" />
            <small class="muted">
              คำสั่งตรวจสุขภาพในคอนเทนเนอร์ (Docker HEALTHCHECK) — จำเป็นถ้ามี component อื่นตั้ง
              depends_on แบบ "healthy" มาที่ตัวนี้ (เช่น <code>pg_isready -U app</code>, <code>redis-cli ping</code>)
            </small>
          </label>

          <label>
            <span>Command (ไม่บังคับ)</span>
            <input v-model="form.command" class="mono" placeholder="node server.js" />
          </label>

          <div class="form-grid">
            <label>
              <span>CPU limit (ไม่บังคับ)</span>
              <input v-model="form.cpuLimit" class="mono" placeholder="0.5" inputmode="decimal" />
            </label>
            <label>
              <span>Memory limit MB (ไม่บังคับ)</span>
              <input v-model="form.memoryLimitMb" class="mono" placeholder="512" inputmode="numeric" />
            </label>
            <label>
              <span>Restart policy</span>
              <select v-model="form.restartPolicy">
                <option value="unless-stopped">unless-stopped</option>
                <option value="on-failure">on-failure</option>
                <option value="always">always</option>
                <option value="no">no</option>
              </select>
            </label>
          </div>
        </template>

        <!-- dependsOn -->
        <div v-if="dependableComponents.length > 0" class="stack-sm">
          <span class="field-label">Depends on (เริ่มหลัง component เหล่านี้)</span>
          <div v-for="dc in dependableComponents" :key="dc.id" class="dep-row">
            <div class="check-row">
              <input
                :id="`dep-${dc.id}`"
                type="checkbox"
                :checked="dc.name in depSelections"
                @change="toggleDep(dc.name, ($event.target as HTMLInputElement).checked)"
              />
              <label :for="`dep-${dc.id}`" class="mono">{{ dc.name }}</label>
            </div>
            <select
              v-if="dc.name in depSelections"
              v-model="depSelections[dc.name]"
              class="dep-cond"
            >
              <option value="started">started (แค่เริ่มแล้ว)</option>
              <option value="healthy">healthy (ผ่าน health check)</option>
            </select>
          </div>
        </div>

        <p v-if="formError" class="alert alert-bad small">
          <AppIcon name="alert" :size="13" />
          <span>{{ formError }}</span>
        </p>

        <div class="form-actions">
          <button class="primary small" :disabled="saving || !form.name.trim()" @click="submitForm">
            <span v-if="saving" class="spinner" />
            {{ saving ? "กำลังบันทึก…" : formMode === "create" ? "เพิ่ม" : "บันทึก" }}
          </button>
          <button class="secondary small" :disabled="saving" @click="closeForm">ยกเลิก</button>
        </div>
      </div>

      <!-- Promote to compose -->
      <div v-if="mode === 'single' && !archived" class="promote-panel inset">
        <div class="row-between wrap">
          <div class="stack-sm">
            <strong>เปลี่ยนเป็น multi-container (compose)</strong>
            <span class="muted small">
              <template v-if="canPromote">
                พร้อมแล้ว — deploy ครั้งถัดไปจะรัน {{ components.length }} component
              </template>
              <template v-else>
                ต้องมีอย่างน้อย 1 component และอย่างน้อย 1 ตัวที่เป็น web ก่อนถึงจะเปลี่ยนได้
              </template>
            </span>
          </div>
          <button class="primary small" :disabled="!canPromote || promoting" @click="promote">
            <span v-if="promoting" class="spinner" />
            {{ promoting ? "กำลังเปลี่ยน…" : "เปลี่ยนเป็น compose" }}
          </button>
        </div>
        <p v-if="promoteError" class="alert alert-bad small">
          <AppIcon name="alert" :size="13" />
          <span>{{ promoteError }}</span>
        </p>
      </div>

      <p class="muted small note">
        <AppIcon name="info" :size="13" />
        การเปลี่ยนแปลง component จะมีผลเมื่อ deploy ครั้งถัดไป
      </p>
    </template>
  </div>
</template>

<style scoped>
.cmp-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}
.cmp-item {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}
.cmp-item.off {
  opacity: 0.6;
}
.cmp-header {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
}
.cmp-actions {
  display: flex;
  gap: var(--s-2);
  flex-wrap: wrap;
}

.dep-chips {
  display: flex;
  gap: var(--s-2);
  flex-wrap: wrap;
}
.dep-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.1rem 0.5rem;
  background: var(--surface-3);
  border-radius: var(--r-sm);
  font-size: var(--t-xs);
  font-family: var(--font-mono, monospace);
}

/* ── Form ── */
.cmp-form {
  gap: var(--s-3);
}
.form-title {
  font-size: var(--t-sm);
  font-weight: 600;
  margin: 0;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--s-3);
}
.field-label {
  font-size: var(--t-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.dep-row {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  flex-wrap: wrap;
}
.dep-cond {
  max-width: 260px;
}
.form-actions {
  display: flex;
  gap: var(--s-2);
}

.confirm-delete {
  border-top: 1px solid var(--border-subtle);
  padding-top: var(--s-3);
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.confirm-actions {
  display: flex;
  gap: var(--s-2);
}

.promote-panel {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  border-color: var(--accent-tint-strong);
}

.note {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
</style>
