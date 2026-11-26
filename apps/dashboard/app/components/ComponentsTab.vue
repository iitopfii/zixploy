<script setup lang="ts">
/**
 * Components Tab — multi-container (compose-style) projects, Phase 18 · C3
 *
 * แก้ไข project_components ผ่าน CRUD ทีละตัว (ไม่ใช่ bulk PUT เหมือน env) แล้ว "promote"
 * โปรเจกต์เป็น mode='compose' เมื่อพร้อม (มี ≥1 component + ≥1 web) — deploy ครั้งถัดไปจะวิ่ง
 * multi-container orchestrator แทน pipeline เดิม
 *
 * build component เลือก repo/branch ของตัวเองได้ (0.1.25) — โปรเจกต์ที่โค้ดอยู่หลาย repo (เช่น backend กับ
 * frontend) อยู่ในโปรเจกต์เดียว คุยกันผ่านชื่อ component บน network ภายในได้เหมือน compose
 *
 * ADR-0002: หน้านี้แค่เขียน config ผ่าน API — worker เป็นฝ่ายเอาไปสร้าง container จริง
 */
import type { PickedRepo, PickerInstallation } from "./RepositoryPicker.vue";

const props = defineProps<{
  projectId: string;
  archived: boolean;
  mode: "single" | "compose";
  /** GitHub installation ที่ active — ใช้เลือก repo ของ build component */
  installations?: PickerInstallation[];
}>();
const emit = defineEmits<{ changed: [] }>();

const api = useApi();
const { t } = useI18n();
const { isAdmin, canWrite } = usePermissions();

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
  gitSource: GitSource | null;
  imageRef: string | null;
  managedServiceId: string | null;
  command: string | null;
  internalPort: number | null;
  isWeb: boolean;
  webPort: number | null;
  healthCheckPath: string | null;
  healthCheckIntervalSec: number;
  healthCheckTimeoutSec: number;
  healthCheckRetries: number;
  healthCmd: string | null;
  cpuLimit: number | null;
  memoryLimitMb: number | null;
  memorySwapMb: number | null;
  pidsLimit: number | null;
  capDropAll: boolean;
  noNewPrivileges: boolean;
  restartPolicy: string;
  position: number;
  enabled: boolean;
  dependsOn: ComponentDep[];
}

interface GitSource {
  installationId: number;
  repoFullName: string;
  branch: string;
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
      loadError.value = t("components.error.load");
      return;
    }
    components.value = (data?.items ?? []) as Component[];
  } catch {
    loadError.value = t("common.apiUnreachable");
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
  /** null = build จาก repo ของ project */
  gitSource: null as GitSource | null,
  imageRef: "",
  managedServiceId: "",
  command: "",
  internalPort: "",
  isWeb: false,
  webPort: "",
  healthCheckPath: "",
  healthCheckIntervalSec: "5",
  healthCheckTimeoutSec: "30",
  healthCheckRetries: "3",
  healthCmd: "",
  cpuLimit: "",
  memoryLimitMb: "",
  memorySwapMb: "",
  pidsLimit: "",
  capDropAll: false,
  noNewPrivileges: false,
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
    gitSource: c.gitSource ? { ...c.gitSource } : null,
    imageRef: c.imageRef ?? "",
    managedServiceId: c.managedServiceId ?? "",
    command: c.command ?? "",
    healthCmd: c.healthCmd ?? "",
    internalPort: c.internalPort != null ? String(c.internalPort) : "",
    isWeb: c.isWeb,
    webPort: c.webPort != null ? String(c.webPort) : "",
    healthCheckPath: c.healthCheckPath ?? "",
    healthCheckIntervalSec: String(c.healthCheckIntervalSec),
    healthCheckTimeoutSec: String(c.healthCheckTimeoutSec),
    healthCheckRetries: String(c.healthCheckRetries),
    cpuLimit: c.cpuLimit != null ? String(c.cpuLimit) : "",
    memoryLimitMb: c.memoryLimitMb != null ? String(c.memoryLimitMb) : "",
    memorySwapMb: c.memorySwapMb != null ? String(c.memorySwapMb) : "",
    pidsLimit: c.pidsLimit != null ? String(c.pidsLimit) : "",
    capDropAll: c.capDropAll,
    noNewPrivileges: c.noNewPrivileges,
    restartPolicy: c.restartPolicy,
  });
  for (const d of c.dependsOn) depSelections[d.name] = d.condition;
  formMode.value = "edit";
}

function closeForm() {
  formMode.value = null;
  editingId.value = null;
  pickingRepo.value = false;
  resetForm();
}

/** กำลังเลือก repo ของ component (เปิด RepositoryPicker) */
const pickingRepo = ref(false);

function onRepoPicked(picked: PickedRepo) {
  form.gitSource = {
    installationId: picked.installationId,
    repoFullName: picked.repoFullName,
    branch: picked.branch,
  };
  pickingRepo.value = false;
}

function useProjectRepo() {
  form.gitSource = null;
  pickingRepo.value = false;
}

function toggleDep(name: string, checked: boolean) {
  if (checked) depSelections[name] = depSelections[name] ?? "started";
  else delete depSelections[name];
}

/** "" → null, ไม่งั้นเป็น Number (ให้ API validate ช่วงค่าเอง) */
function toNum(s: string): number | null {
  const trimmed = s.trim();
  return trimmed === "" ? null : Number(trimmed);
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
    // ช่องว่าง = ไม่ส่ง (API คงค่าเดิม/ใช้ค่าเริ่มต้น)
    ...(toNum(form.healthCheckIntervalSec) != null
      ? { healthCheckIntervalSec: Number(form.healthCheckIntervalSec) }
      : {}),
    ...(toNum(form.healthCheckTimeoutSec) != null
      ? { healthCheckTimeoutSec: Number(form.healthCheckTimeoutSec) }
      : {}),
    ...(toNum(form.healthCheckRetries) != null
      ? { healthCheckRetries: Number(form.healthCheckRetries) }
      : {}),
    healthCmd: form.healthCmd.trim() === "" ? null : form.healthCmd.trim(),
    cpuLimit: toNum(form.cpuLimit),
    memoryLimitMb: toNum(form.memoryLimitMb),
    memorySwapMb: toNum(form.memorySwapMb),
    pidsLimit: toNum(form.pidsLimit),
    capDropAll: form.capDropAll,
    noNewPrivileges: form.noNewPrivileges,
  };

  if (form.sourceKind === "build") {
    return {
      ...runtime,
      dockerfilePath: form.dockerfilePath.trim() || "Dockerfile",
      buildContext: form.buildContext.trim() || ".",
      targetStage: form.targetStage.trim() === "" ? null : form.targetStage.trim(),
      gitSource: form.gitSource,
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
        formError.value = apiErrorMessage(error, "components.error.create");
        return;
      }
    } else if (editingId.value) {
      const { error } = await api.api.v1
        .projects({ id: props.projectId })
        .components({ componentId: editingId.value })
        .patch(payload);
      if (error) {
        formError.value = apiErrorMessage(error, "common.saveFailed");
        return;
      }
    }
    closeForm();
    await fetchComponents();
  } catch {
    formError.value = t("common.apiUnreachable");
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
      deleteError.value = apiErrorMessage(error, "common.deleteFailed");
      return;
    }
    confirmDeleteId.value = null;
    await fetchComponents();
  } catch {
    deleteError.value = t("common.apiUnreachable");
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
      promoteError.value = apiErrorMessage(error, "components.error.promote");
      return;
    }
    await fetchComponents();
    emit("changed"); // ให้ parent refresh project เพื่ออัปเดต mode badge
  } catch {
    promoteError.value = t("common.apiUnreachable");
  } finally {
    promoting.value = false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  if (c.sourceKind === "build") {
    const path = `${c.buildContext ?? "."} · ${c.dockerfilePath ?? "Dockerfile"}`;
    return c.gitSource ? `${c.gitSource.repoFullName}@${c.gitSource.branch} · ${path}` : path;
  }
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
        <p class="muted small">{{ $t("components.subtitle") }}</p>
      </div>
      <span class="badge" :class="mode === 'compose' ? 'tone-ok' : 'tone-idle'">
        {{ mode === "compose" ? $t("components.mode.compose") : $t("components.mode.single") }}
      </span>
    </div>

    <!-- single-mode intro -->
    <div v-if="mode === 'single'" class="alert alert-warn">
      <AppIcon name="info" :size="16" />
      <div class="stack-sm">
        <strong>{{ $t("components.singleIntro.title") }}</strong>
        <span class="muted small">{{ $t("components.singleIntro.body") }}</span>
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
        <span class="empty-title">{{ $t("components.empty.title") }}</span>
        <p class="small">{{ $t("components.empty.hint") }}</p>
      </div>

      <ul v-else-if="components.length > 0" class="cmp-list">
        <li v-for="c in components" :key="c.id" class="inset cmp-item" :class="{ off: !c.enabled }">
          <div class="cmp-header">
            <strong class="mono">{{ c.name }}</strong>
            <span class="badge" :class="roleTone(c.role)">{{ c.role }}</span>
            <span class="badge">{{ SOURCE_LABEL[c.sourceKind] }}</span>
            <span v-if="c.isWeb" class="badge tone-ok">web · :{{ c.webPort ?? "?" }}</span>
            <span v-if="!c.enabled" class="badge tone-idle">{{ $t("components.disabledBadge") }}</span>
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

          <div v-if="canWrite && !archived" class="cmp-actions">
            <button class="secondary small" @click="openEdit(c)">
              <AppIcon name="settings" :size="13" />
              {{ $t("common.edit") }}
            </button>
            <button
              class="secondary small"
              :disabled="togglingId === c.id"
              @click="toggleEnabled(c)"
            >
              <span v-if="togglingId === c.id" class="spinner" />
              {{ c.enabled ? $t("components.action.disable") : $t("components.action.enable") }}
            </button>
            <button class="danger small" @click="confirmDeleteId = c.id; deleteError = ''">
              <AppIcon name="trash" :size="13" />
              {{ $t("common.delete") }}
            </button>
          </div>

          <!-- inline delete confirm -->
          <div v-if="confirmDeleteId === c.id && canWrite" class="confirm-delete">
            <i18n-t scope="global" keypath="components.confirmDelete.message" tag="p" class="warn-text small">
              <template #name>
                <strong>{{ c.name }}</strong>
              </template>
            </i18n-t>
            <p v-if="deleteError" class="alert alert-bad small">
              <AppIcon name="alert" :size="13" />
              <span>{{ deleteError }}</span>
            </p>
            <div class="confirm-actions">
              <button class="danger small" :disabled="deleting" @click="removeComponent(c.id)">
                <span v-if="deleting" class="spinner" />
                {{ deleting ? $t("common.deleting") : $t("components.confirmDelete.confirm") }}
              </button>
              <button class="secondary small" @click="confirmDeleteId = null">
                {{ $t("common.cancel") }}
              </button>
            </div>
          </div>
        </li>
      </ul>

      <!-- Add button -->
      <div v-if="canWrite && !archived && formMode === null">
        <button class="primary small" @click="openCreate">
          <AppIcon name="plus" :size="14" />
          {{ $t("components.add") }}
        </button>
      </div>

      <!-- Create/Edit form -->
      <div v-if="formMode !== null && canWrite" class="inset stack cmp-form">
        <h3 class="form-title">
          {{
            formMode === "create"
              ? $t("components.add")
              : $t("components.form.editTitle", { name: form.name })
          }}
        </h3>

        <div class="form-grid">
          <label>
            <span>{{ $t("components.form.name") }}</span>
            <input v-model="form.name" class="mono" placeholder="web, api, cache" :disabled="formMode === 'edit'" />
            <small class="muted">{{ $t("components.form.nameHint") }}</small>
          </label>
          <label>
            <span>{{ $t("components.form.role") }}</span>
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
          <span>{{ $t("components.form.source") }}</span>
          <select v-model="form.sourceKind" :disabled="formMode === 'edit'">
            <option value="build">{{ $t("components.form.sourceBuild") }}</option>
            <option value="image">{{ $t("components.form.sourceImage") }}</option>
            <option v-if="isAdmin || formMode === 'edit'" value="managed_ref">
              {{ $t("components.form.sourceManaged") }}
            </option>
          </select>
          <small v-if="formMode === 'edit'" class="muted">
            {{ $t("components.form.sourceLocked") }}
          </small>
        </label>

        <!-- build: repo ของ component (ไม่ตั้ง = repo ของ project) -->
        <div v-if="form.sourceKind === 'build'" class="repo-source">
          <span class="repo-label">Repository</span>
          <div class="repo-row">
            <span v-if="form.gitSource" class="mono">
              {{ form.gitSource.repoFullName }} @ {{ form.gitSource.branch }}
            </span>
            <span v-else class="muted">{{ $t("components.repo.useProject") }}</span>
            <button
              type="button"
              class="secondary small"
              :disabled="!installations || installations.length === 0"
              @click="pickingRepo = !pickingRepo"
            >
              {{
                pickingRepo
                  ? $t("common.cancel")
                  : form.gitSource
                    ? $t("components.repo.change")
                    : $t("components.repo.other")
              }}
            </button>
            <button v-if="form.gitSource" type="button" class="secondary small" @click="useProjectRepo">
              {{ $t("components.repo.backToProject") }}
            </button>
          </div>
          <small v-if="!installations || installations.length === 0" class="muted">
            {{ $t("components.repo.needGithub") }}
          </small>
          <small v-else class="muted">
            {{ $t("components.repo.hint") }}
          </small>
          <RepositoryPicker
            v-if="pickingRepo && installations && installations.length > 0"
            :installations="installations"
            @pick="onRepoPicked"
          />
        </div>

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
            <span>{{ $t("components.form.targetStage") }}</span>
            <input v-model="form.targetStage" class="mono" placeholder="production" />
          </label>
        </div>

        <!-- image field -->
        <label v-if="form.sourceKind === 'image'">
          <span>Image reference</span>
          <input v-model="form.imageRef" class="mono" placeholder="redis:7-alpine" />
          <small class="muted">{{ $t("components.form.imageHint") }}</small>
        </label>

        <!-- managed_ref field -->
        <label v-if="form.sourceKind === 'managed_ref'">
          <span>Managed database</span>
          <select v-model="form.managedServiceId" :disabled="!isAdmin">
            <option value="">{{ $t("components.form.selectService") }}</option>
            <option v-for="s in services" :key="s.id" :value="s.id">{{ s.name }} ({{ s.type }})</option>
          </select>
          <small v-if="services.length === 0" class="muted">
            {{ $t("components.form.noServices") }}
          </small>
          <small v-else class="muted">
            {{ $t("components.form.managedEnvHint") }}
            <code>{{ (form.name || "db").toUpperCase().replace(/-/g, "_") }}_URL</code>,
            <code>_HOST</code>, <code>_PORT</code>, <code>_USERNAME</code>, <code>_PASSWORD</code>,
            <code>_DATABASE</code>
          </small>
        </label>

        <!-- runtime fields (build/image only) -->
        <template v-if="form.sourceKind !== 'managed_ref'">
          <div class="check-row">
            <input id="cmp-isweb" v-model="form.isWeb" type="checkbox" />
            <label for="cmp-isweb">{{ $t("components.form.isWeb") }}</label>
          </div>

          <div class="form-grid">
            <label v-if="form.isWeb">
              <span>Web port</span>
              <input v-model="form.webPort" class="mono" placeholder="3000" inputmode="numeric" />
            </label>
            <label>
              <span>{{ $t("components.form.internalPort") }}</span>
              <input v-model="form.internalPort" class="mono" placeholder="3000" inputmode="numeric" />
            </label>
            <label>
              <span>{{ $t("components.form.healthPath") }}</span>
              <input v-model="form.healthCheckPath" class="mono" placeholder="/health" />
            </label>
          </div>

          <div class="form-grid">
            <label>
              <span>{{ $t("components.form.healthInterval") }}</span>
              <input
                v-model="form.healthCheckIntervalSec"
                class="mono"
                placeholder="5"
                inputmode="numeric"
              />
            </label>
            <label>
              <span>{{ $t("components.form.healthTimeout") }}</span>
              <input
                v-model="form.healthCheckTimeoutSec"
                class="mono"
                placeholder="30"
                inputmode="numeric"
              />
            </label>
            <label>
              <span>Health retries</span>
              <input
                v-model="form.healthCheckRetries"
                class="mono"
                placeholder="3"
                inputmode="numeric"
              />
            </label>
          </div>
          <small class="muted">{{ $t("components.form.healthWaitHint") }}</small>

          <label>
            <span>{{ $t("components.form.healthCmd") }}</span>
            <input v-model="form.healthCmd" class="mono" placeholder="redis-cli ping" />
            <i18n-t scope="global" keypath="components.form.healthCmdHint" tag="small" class="muted">
              <template #a><code>pg_isready -U app</code></template>
              <template #b><code>redis-cli ping</code></template>
            </i18n-t>
          </label>

          <label>
            <span>{{ $t("components.form.command") }}</span>
            <input v-model="form.command" class="mono" placeholder="node server.js" />
            <i18n-t scope="global" keypath="components.form.commandHint" tag="small" class="muted">
              <template #example><code>sh -c "..."</code></template>
            </i18n-t>
          </label>

          <div class="form-grid">
            <label>
              <span>{{ $t("components.form.cpuLimit") }}</span>
              <input v-model="form.cpuLimit" class="mono" placeholder="0.5" inputmode="decimal" />
            </label>
            <label>
              <span>{{ $t("components.form.memoryLimit") }}</span>
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
            <label>
              <span>{{ $t("components.form.memorySwap") }}</span>
              <input
                v-model="form.memorySwapMb"
                class="mono"
                :placeholder="$t('components.form.memorySwapPlaceholder')"
                inputmode="numeric"
              />
            </label>
            <label>
              <span>{{ $t("components.form.pidsLimit") }}</span>
              <input v-model="form.pidsLimit" class="mono" placeholder="512" inputmode="numeric" />
            </label>
          </div>
          <div class="check-row">
            <input id="comp-cap-drop" v-model="form.capDropAll" type="checkbox" />
            <i18n-t scope="global" keypath="components.form.capDropAll" tag="label" for="comp-cap-drop">
              <template #flag><code>--cap-drop ALL</code></template>
            </i18n-t>
          </div>
          <div class="check-row">
            <input id="comp-nnp" v-model="form.noNewPrivileges" type="checkbox" />
            <i18n-t scope="global" keypath="components.form.noNewPrivileges" tag="label" for="comp-nnp">
              <template #flag><code>no-new-privileges</code></template>
            </i18n-t>
          </div>
        </template>

        <!-- dependsOn -->
        <div v-if="dependableComponents.length > 0" class="stack-sm">
          <span class="field-label">{{ $t("components.form.dependsOn") }}</span>
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
              <option value="started">{{ $t("components.form.depStarted") }}</option>
              <option value="healthy">{{ $t("components.form.depHealthy") }}</option>
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
            {{
              saving
                ? $t("common.saving")
                : formMode === "create"
                  ? $t("common.add")
                  : $t("common.save")
            }}
          </button>
          <button class="secondary small" :disabled="saving" @click="closeForm">
            {{ $t("common.cancel") }}
          </button>
        </div>
      </div>

      <!-- Promote to compose -->
      <div v-if="mode === 'single' && canWrite && !archived" class="promote-panel inset">
        <div class="row-between wrap">
          <div class="stack-sm">
            <strong>{{ $t("components.promote.title") }}</strong>
            <span class="muted small">
              <template v-if="canPromote">
                {{ $t("components.promote.ready", { n: components.length }, components.length) }}
              </template>
              <template v-else>
                {{ $t("components.promote.notReady") }}
              </template>
            </span>
          </div>
          <button class="primary small" :disabled="!canPromote || promoting" @click="promote">
            <span v-if="promoting" class="spinner" />
            {{ promoting ? $t("components.promote.working") : $t("components.promote.action") }}
          </button>
        </div>
        <p v-if="promoteError" class="alert alert-bad small">
          <AppIcon name="alert" :size="13" />
          <span>{{ promoteError }}</span>
        </p>
      </div>

      <p class="muted small note">
        <AppIcon name="info" :size="13" />
        {{ $t("components.note") }}
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
.repo-source {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.repo-label {
  font-size: var(--t-sm);
  font-weight: 500;
}
.repo-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--s-2);
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
