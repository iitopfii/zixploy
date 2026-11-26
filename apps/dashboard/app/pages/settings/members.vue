<script setup lang="ts">
/**
 * สมาชิกและสิทธิ์ (0.1.28) — admin เท่านั้น (middleware/auth.global.ts กันไว้ และ API ตรวจซ้ำ)
 *
 * role เป็นของทั้งระบบ ส่วนโปรเจกต์ที่เข้าถึงได้เลือกรายคน: developer/viewer เห็นเฉพาะ
 * โปรเจกต์ที่ติ๊กให้ · admin เห็นทุกโปรเจกต์ รายการโปรเจกต์จึงไม่มีผลกับ admin
 */
const api = useApi();
const session = useSession();
const { t } = useI18n();

type Role = "admin" | "developer" | "viewer";
const ROLES: Role[] = ["admin", "developer", "viewer"];
const PASSWORD_MIN_LENGTH = 12;

const {
  data,
  refresh,
  error: loadError,
} = await useAsyncData("members", async () => {
  const [members, projects] = await Promise.all([
    api.api.v1.members.get(),
    api.api.v1.projects.get({ query: {} }),
  ]);
  if (members.error) throw new Error(apiErrorMessage(members.error, "members.error.load"));
  return {
    members: members.data?.items ?? [],
    projects: projects.data?.items ?? [],
  };
});

const members = computed(() => data.value?.members ?? []);
const projects = computed(() => data.value?.projects ?? []);
type Member = (typeof members.value)[number];

const isSelf = (member: Member) => member.id === session.value.userId;

function projectSummary(member: Member): string {
  if (member.role === "admin") return t("members.allProjects");
  if (member.projectIds.length === 0) return t("members.noProjects");
  return trCount("members.projectCount", member.projectIds.length);
}

// ── ฟอร์มเพิ่ม/แก้ไข ──────────────────────────────────────────────────────
const editing = ref<Member | null>(null);
const formOpen = ref(false);
const form = reactive({
  username: "",
  password: "",
  role: "developer" as Role,
  projectIds: [] as string[],
});
const saving = ref(false);
const formError = ref("");

function openCreate() {
  editing.value = null;
  Object.assign(form, { username: "", password: "", role: "developer", projectIds: [] });
  formError.value = "";
  formOpen.value = true;
}

function openEdit(member: Member) {
  editing.value = member;
  Object.assign(form, {
    username: member.username,
    password: "",
    role: member.role,
    projectIds: [...member.projectIds],
  });
  formError.value = "";
  formOpen.value = true;
}

function closeForm() {
  if (!saving.value) formOpen.value = false;
}

const canSubmit = computed(() => {
  if (saving.value) return false;
  if (editing.value) return form.password === "" || form.password.length >= PASSWORD_MIN_LENGTH;
  return (
    /^[a-zA-Z0-9._-]{3,64}$/.test(form.username) && form.password.length >= PASSWORD_MIN_LENGTH
  );
});

async function submit() {
  if (!canSubmit.value) return;
  saving.value = true;
  formError.value = "";
  try {
    const target = editing.value;
    const { error } = target
      ? await api.api.v1.members({ id: target.id }).patch({
          // บัญชีตัวเอง: API ปฏิเสธการเปลี่ยน role จึงไม่ส่งไป
          ...(isSelf(target) ? {} : { role: form.role }),
          projectIds: form.projectIds,
          ...(form.password ? { password: form.password } : {}),
        })
      : await api.api.v1.members.post({
          username: form.username,
          password: form.password,
          role: form.role,
          projectIds: form.projectIds,
        });
    if (error) {
      formError.value = apiErrorMessage(error, "members.error.save");
      return;
    }
    formOpen.value = false;
    await refresh();
  } catch {
    formError.value = t("common.apiUnreachable");
  } finally {
    saving.value = false;
  }
}

// ── ปิด/เปิด/ลบ ────────────────────────────────────────────────────────────
const pending = ref<{ kind: "disable" | "delete"; member: Member } | null>(null);
const acting = ref(false);
const actionError = ref("");

async function setDisabled(member: Member, disabled: boolean) {
  actionError.value = "";
  const { error } = await api.api.v1.members({ id: member.id }).patch({ disabled });
  if (error) actionError.value = apiErrorMessage(error, "members.error.save");
  await refresh();
}

async function confirmPending() {
  const action = pending.value;
  if (!action) return;
  acting.value = true;
  actionError.value = "";
  try {
    if (action.kind === "disable") {
      await setDisabled(action.member, true);
    } else {
      const { error } = await api.api.v1.members({ id: action.member.id }).delete();
      if (error) actionError.value = apiErrorMessage(error, "members.error.delete");
      await refresh();
    }
    pending.value = null;
  } catch {
    actionError.value = t("common.apiUnreachable");
  } finally {
    acting.value = false;
  }
}
</script>

<template>
  <div class="stack-lg">
    <header class="row-between wrap">
      <div>
        <h1>{{ $t("members.title") }}</h1>
        <p class="muted">{{ $t("members.subtitle") }}</p>
      </div>
      <button class="primary" type="button" @click="openCreate">
        <AppIcon name="plus" :size="15" />
        {{ $t("members.add") }}
      </button>
    </header>

    <p v-if="loadError" class="alert alert-bad" role="alert">
      <AppIcon name="alert" :size="15" />
      <span>{{ loadError.message || $t("members.error.load") }}</span>
    </p>
    <p v-if="actionError" class="alert alert-bad" role="alert">
      <AppIcon name="alert" :size="15" />
      <span>{{ actionError }}</span>
    </p>

    <section class="card table-card">
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th>{{ $t("members.col.username") }}</th>
              <th>{{ $t("members.col.role") }}</th>
              <th>{{ $t("members.col.projects") }}</th>
              <th>{{ $t("members.col.lastSeen") }}</th>
              <th>{{ $t("members.col.status") }}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="member in members" :key="member.id" :class="{ off: member.disabled }">
              <td>
                <span class="mono">{{ member.username }}</span>
                <span v-if="isSelf(member)" class="badge you">{{ $t("members.you") }}</span>
              </td>
              <td>
                <span class="badge" :class="`role-${member.role}`">
                  {{ $t(`nav.role.${member.role}`) }}
                </span>
              </td>
              <td class="muted">{{ projectSummary(member) }}</td>
              <td class="muted" :title="fullDateTime(member.lastSeenAt)">
                {{ member.lastSeenAt ? timeAgo(member.lastSeenAt) : $t("members.never") }}
              </td>
              <td>
                <span class="status" :class="member.disabled ? 'status-stopped' : 'status-active'">
                  {{ member.disabled ? $t("members.disabled") : $t("members.active") }}
                </span>
              </td>
              <td>
                <div class="actions-end row-actions">
                  <button class="ghost small" type="button" @click="openEdit(member)">
                    {{ $t("members.action.edit") }}
                  </button>
                  <template v-if="!isSelf(member)">
                    <button
                      v-if="member.disabled"
                      class="ghost small"
                      type="button"
                      @click="setDisabled(member, false)"
                    >
                      {{ $t("members.action.enable") }}
                    </button>
                    <button
                      v-else
                      class="ghost small"
                      type="button"
                      @click="pending = { kind: 'disable', member }"
                    >
                      {{ $t("members.action.disable") }}
                    </button>
                    <button
                      class="ghost small danger-text"
                      type="button"
                      @click="pending = { kind: 'delete', member }"
                    >
                      {{ $t("members.action.delete") }}
                    </button>
                  </template>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="members.length <= 1" class="muted small empty-note">{{ $t("members.empty") }}</p>
    </section>

    <section class="card stack-sm">
      <dl class="kv role-help">
        <template v-for="role in ROLES" :key="role">
          <dt>{{ $t(`nav.role.${role}`) }}</dt>
          <dd class="muted">{{ $t(`members.roleHelp.${role}`) }}</dd>
        </template>
      </dl>
    </section>

    <Teleport to="body">
      <Transition name="fade">
        <div v-if="formOpen" class="backdrop" @click.self="closeForm">
          <form
            class="dialog stack"
            role="dialog"
            aria-modal="true"
            :aria-label="
              editing
                ? $t('members.form.editTitle', { name: editing.username })
                : $t('members.form.createTitle')
            "
            @submit.prevent="submit"
            @keydown.esc="closeForm"
          >
            <h2>
              {{
                editing
                  ? $t("members.form.editTitle", { name: editing.username })
                  : $t("members.form.createTitle")
              }}
            </h2>

            <label v-if="!editing">
              <span>{{ $t("members.form.username") }}</span>
              <input
                v-model.trim="form.username"
                autocomplete="off"
                autofocus
                maxlength="64"
                :disabled="saving"
              />
              <span class="field-hint">{{ $t("members.form.usernameHint") }}</span>
            </label>

            <label>
              <span>
                {{ editing ? $t("members.form.newPassword") : $t("members.form.password") }}
              </span>
              <input
                v-model="form.password"
                type="password"
                autocomplete="new-password"
                :disabled="saving"
              />
              <span class="field-hint">
                {{
                  editing
                    ? $t("members.form.newPasswordHint")
                    : $t("members.form.passwordHint", { n: PASSWORD_MIN_LENGTH })
                }}
              </span>
            </label>

            <p v-if="editing && isSelf(editing)" class="alert alert-info">
              <AppIcon name="info" :size="15" />
              <span>{{ $t("members.form.selfNote") }}</span>
            </p>

            <fieldset v-else class="stack-sm">
              <legend>{{ $t("members.form.role") }}</legend>
              <label v-for="role in ROLES" :key="role" class="check-row role-option">
                <input v-model="form.role" type="radio" name="role" :value="role" :disabled="saving" />
                <span>
                  <strong>{{ $t(`nav.role.${role}`) }}</strong>
                  <span class="muted small role-desc">{{ $t(`members.roleHelp.${role}`) }}</span>
                </span>
              </label>
            </fieldset>

            <fieldset class="stack-sm">
              <legend>{{ $t("members.form.projects") }}</legend>
              <p v-if="form.role === 'admin'" class="muted small">
                {{ $t("members.form.projectsAdmin") }}
              </p>
              <p v-else-if="projects.length === 0" class="muted small">
                {{ $t("members.form.projectsEmpty") }}
              </p>
              <div v-else class="project-list">
                <label v-for="project in projects" :key="project.id" class="check-row">
                  <input
                    v-model="form.projectIds"
                    type="checkbox"
                    :value="project.id"
                    :disabled="saving"
                  />
                  <span class="truncate">{{ project.name }}</span>
                </label>
              </div>
            </fieldset>

            <p v-if="formError" class="alert alert-bad" role="alert">
              <AppIcon name="alert" :size="15" />
              <span>{{ formError }}</span>
            </p>

            <div class="actions-end">
              <button type="button" class="ghost" :disabled="saving" @click="closeForm">
                {{ $t("common.cancel") }}
              </button>
              <button type="submit" class="primary" :disabled="!canSubmit">
                <span v-if="saving" class="spinner" />
                {{ saving ? $t("common.saving") : $t("common.save") }}
              </button>
            </div>
          </form>
        </div>
      </Transition>
    </Teleport>

    <ConfirmDialog
      :open="pending !== null"
      :title="
        pending
          ? $t(`members.${pending.kind === 'delete' ? 'confirmDelete' : 'confirmDisable'}.title`, {
              name: pending.member.username,
            })
          : ''
      "
      :message="
        pending
          ? $t(`members.${pending.kind === 'delete' ? 'confirmDelete' : 'confirmDisable'}.message`)
          : ''
      "
      :confirm-label="
        pending?.kind === 'delete' ? $t('members.action.delete') : $t('members.action.disable')
      "
      :require-typed="pending?.kind === 'delete' ? pending.member.username : undefined"
      :busy="acting"
      @confirm="confirmPending"
      @cancel="pending = null"
    />
  </div>
</template>

<style scoped>
.table-card {
  padding: 0;
}

.table-scroll {
  overflow-x: auto;
}

.table td {
  white-space: nowrap;
}

tr.off td {
  opacity: 0.6;
}

.badge.you {
  margin-left: var(--s-2);
}

.role-admin {
  color: var(--accent);
}

.row-actions {
  gap: var(--s-1);
}

.danger-text {
  color: var(--bad);
}

.empty-note {
  padding: var(--s-3) var(--s-4);
}

.role-help {
  grid-template-columns: max-content minmax(0, 1fr);
}

.dialog {
  width: min(520px, 100%);
  max-height: calc(100vh - var(--s-6));
  overflow-y: auto;
  padding: var(--s-5);
  background: var(--surface-1);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-lg), var(--shadow-inset);
}

fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}

legend {
  padding: 0;
  margin-bottom: var(--s-2);
  font-size: 13px;
  color: var(--text-muted);
}

.role-option {
  align-items: flex-start;
}

.role-desc {
  display: block;
}

.project-list {
  display: grid;
  gap: var(--s-1);
  max-height: 200px;
  overflow-y: auto;
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r);
}
</style>
