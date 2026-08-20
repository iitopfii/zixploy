<script setup lang="ts">
/**
 * Deploy Tab — Phase 3
 *
 * Actions: deploy, redeploy, restart, stop, rollback, cancel
 * History: deployment list with status, timestamps, rollback button
 */
const props = defineProps<{
  projectId: string;
  hasSource: boolean;
  archived: boolean;
  autoDeploy: boolean;
  branch: string | null;
  /** 'dockerfile' = ไม่มี push event ให้ auto deploy ฟังเลย (ไม่ผ่าน GitHub) — ซ่อน toggle ไปเลย */
  sourceType?: "github" | "dockerfile";
}>();

/** auto deploy มีความหมายเฉพาะ source ที่มี webhook push จริง (GitHub) เท่านั้น */
const autoDeploySupported = computed(() => (props.sourceType ?? "github") !== "dockerfile");

const emit = defineEmits<{ "auto-deploy-changed": [] }>();

const api = useApi();

// ---------------------------------------------------------------------------
// Auto deploy toggle
// ---------------------------------------------------------------------------

/**
 * เก็บ state ในเครื่องเพื่อให้สวิตช์ตอบสนองทันที แล้วค่อย sync กลับถ้า API ล้มเหลว
 * (รอ round-trip ก่อนขยับทำให้รู้สึกว่าคลิกไม่ติด)
 */
const autoDeployLocal = ref(props.autoDeploy);
watch(
  () => props.autoDeploy,
  (v) => (autoDeployLocal.value = v),
);

const savingAutoDeploy = ref(false);
const autoDeployError = ref("");

async function toggleAutoDeploy() {
  if (savingAutoDeploy.value || props.archived) return;
  const next = !autoDeployLocal.value;
  autoDeployLocal.value = next;
  savingAutoDeploy.value = true;
  autoDeployError.value = "";
  try {
    const { error } = await api.api.v1.projects({ id: props.projectId }).patch({
      autoDeploy: next,
    });
    if (error) {
      autoDeployLocal.value = !next; // คืนค่าเดิมเมื่อบันทึกไม่สำเร็จ
      const body = error.value as { error?: { message?: string } } | null;
      autoDeployError.value = body?.error?.message ?? "บันทึกไม่สำเร็จ";
      return;
    }
    emit("auto-deploy-changed");
  } catch {
    autoDeployLocal.value = !next;
    autoDeployError.value = "ติดต่อ API ไม่ได้";
  } finally {
    savingAutoDeploy.value = false;
  }
}

// ---------------------------------------------------------------------------
// Deployment list
// ---------------------------------------------------------------------------

interface Deployment {
  id: string;
  status: string;
  trigger: string;
  commitSha: string;
  commitMessage: string | null;
  commitAuthor: string | null;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  failureCode: string | null;
  failureMessage: string | null;
}

const deployments = ref<Deployment[]>([]);
const nextCursor = ref<string | undefined>(undefined);
const total = ref(0);
const loadingList = ref(true);
const listError = ref("");

/**
 * deployment ล่าสุด (หัวรายการหน้าแรก) — เก็บแยกจาก deployments เพราะ pagination
 * ทำให้ deployments[0] ไม่ใช่ตัวล่าสุดเมื่ออยู่หน้าอื่น
 * ใช้โชว์ sha บนปุ่ม Redeploy (redeploy = build ซ้ำ commit ของตัวนี้) และเทียบกับเวลาแก้ env
 */
const latestDeployment = ref<Deployment | null>(null);

const PAGE_SIZE = 10;

/**
 * Pagination แบบ keyset (cursor) ไม่ใช่ offset
 *
 * deployment ใหม่ถูก insert ที่หัวรายการตลอดเวลา — offset pagination จะทำให้แถวเลื่อน
 * แล้วเห็นรายการซ้ำหรือข้ามหายเมื่อมี deploy เกิดขึ้นระหว่างที่เปิดหน้าอยู่
 * cursor ผูกกับ (created_at, id) จึงไม่เลื่อนตาม
 *
 * ข้อแลกเปลี่ยน: cursor เดินหน้าอย่างเดียว — เก็บ stack ของ cursor ที่ผ่านมาไว้เอง
 * เพื่อให้ปุ่ม "ก่อนหน้า" ทำงานได้ (cursorStack[i] = cursor ที่ใช้โหลดหน้า i)
 */
const cursorStack = ref<Array<string | undefined>>([undefined]);
const pageIndex = ref(0);

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const rangeStart = computed(() => (total.value === 0 ? 0 : pageIndex.value * PAGE_SIZE + 1));
const rangeEnd = computed(() => pageIndex.value * PAGE_SIZE + deployments.value.length);

async function fetchDeployments(cursor?: string) {
  listError.value = "";
  try {
    const { data, error } = await api.api.v1.projects({ id: props.projectId }).deployments.get({
      query: { limit: String(PAGE_SIZE), ...(cursor ? { cursor } : {}) },
    });
    if (error) {
      listError.value = "โหลดรายการ deploy ไม่ได้";
      return;
    }
    deployments.value = data?.items ?? [];
    nextCursor.value = data?.nextCursor;
    total.value = data?.total ?? 0;
    // ไม่มี cursor = หน้าแรก — หัวรายการคือ deployment ล่าสุดจริง
    if (!cursor) latestDeployment.value = deployments.value[0] ?? null;
  } catch {
    listError.value = "ติดต่อ API ไม่ได้";
  } finally {
    loadingList.value = false;
  }
}

async function goNext() {
  if (!nextCursor.value) return;
  const cursor = nextCursor.value;
  loadingList.value = true;
  // เก็บ cursor ของหน้าถัดไปไว้ใน stack ก่อน เพื่อให้ย้อนกลับมาหน้านี้ได้
  cursorStack.value = [...cursorStack.value.slice(0, pageIndex.value + 1), cursor];
  pageIndex.value++;
  await fetchDeployments(cursor);
}

async function goPrev() {
  if (pageIndex.value === 0) return;
  loadingList.value = true;
  pageIndex.value--;
  await fetchDeployments(cursorStack.value[pageIndex.value]);
}

/** กลับหน้าแรก — ใช้หลังลบ เพราะ cursor เดิมอาจชี้ไปยังแถวที่หายไปแล้ว */
async function resetToFirstPage() {
  cursorStack.value = [undefined];
  pageIndex.value = 0;
  await fetchDeployments();
}

// ---------------------------------------------------------------------------
// เตือนเมื่อแก้ env แล้วยังไม่ได้ deploy
// ---------------------------------------------------------------------------

/**
 * โหลด envUpdatedAt เองแทนการรับเป็น prop — project ของหน้า [id].vue โหลดตอนเปิดหน้า
 * ถ้าผู้ใช้แก้ env ในแท็บ Environment แล้วสลับมาแท็บนี้ ค่าจาก prop จะเก่า (banner ไม่ขึ้น)
 * ส่วน component นี้ถูก mount ใหม่ทุกครั้งที่เข้าแท็บ (v-else-if) จึงได้ค่าล่าสุดเสมอ
 */
const envUpdatedAt = ref<number | null>(null);

async function fetchEnvUpdatedAt() {
  try {
    const { data } = await api.api.v1.projects({ id: props.projectId }).get();
    envUpdatedAt.value = data?.envUpdatedAt ?? null;
  } catch {
    // banner เป็นตัวช่วยเสริม — โหลดไม่ได้ก็แค่ไม่แสดง ไม่ควรทำให้ทั้งแท็บพัง
  }
}

/**
 * env ถูกแก้หลัง deployment ล่าสุดถูกสั่ง — ค่าที่รันอยู่ยังเป็นชุดเก่าจนกว่าจะ deploy ใหม่
 * (env ถูกอ่านตอนเริ่ม build ไม่ใช่ตอนรัน — Redeploy/Deploy ครั้งถัดไปจึงจะได้ค่าใหม่)
 */
const envChangedAfterDeploy = computed(
  () =>
    envUpdatedAt.value != null &&
    latestDeployment.value != null &&
    envUpdatedAt.value > latestDeployment.value.queuedAt,
);

await Promise.all([fetchDeployments(), fetchEnvUpdatedAt()]);

// ---------------------------------------------------------------------------
// รีเฟรชอัตโนมัติ
//
// deploy เริ่มได้จากหลายทางที่ไม่ใช่หน้านี้ — push เข้า repo (webhook), แท็บอื่น, หรือคนอื่น
// เดิม poll เฉพาะตอนที่ "มีงานค้างอยู่แล้ว" เท่านั้น เปิดหน้าทิ้งไว้เฉย ๆ จึงไม่เห็น deploy ใหม่
// เลยจนกว่าจะกดรีเฟรชเอง — ตอนนี้ poll ตลอด แต่ปรับความถี่ตามสถานการณ์
// ---------------------------------------------------------------------------

const IN_FLIGHT = ["queued", "cloning", "building", "starting", "health_checking", "activating"];
const hasInFlight = computed(() => deployments.value.some((d) => IN_FLIGHT.includes(d.status)));

/** มีงานเดินอยู่ = ต้องเห็นสถานะขยับทันที · ว่าง = แค่คอยจับ deploy ที่เริ่มจากที่อื่น */
const POLL_ACTIVE_MS = 3_000;
const POLL_IDLE_MS = 15_000;

let pollTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  if (!import.meta.client) return;
  pollTimer = setTimeout(
    async () => {
      // แท็บถูกซ่อนอยู่ = ไม่ยิง API ทิ้งไปเรื่อย ๆ (กลับมาดูเมื่อไรมี visibilitychange รีเฟรชให้)
      if (!document.hidden) await fetchDeployments();
      schedulePoll();
    },
    hasInFlight.value ? POLL_ACTIVE_MS : POLL_IDLE_MS,
  );
}

// สลับความถี่ทันทีที่สถานะเปลี่ยน (เพิ่งกด deploy ไม่ต้องรอรอบ idle 15 วิให้ครบก่อน)
watch(hasInFlight, schedulePoll, { immediate: true });

/** กลับมาที่แท็บ = อยากเห็นของสดทันที ไม่ต้องรอรอบ poll ถัดไป */
function onVisibilityChange() {
  if (document.hidden) return;
  fetchDeployments();
  schedulePoll();
}

onMounted(() => document.addEventListener("visibilitychange", onVisibilityChange));
onUnmounted(() => {
  document.removeEventListener("visibilitychange", onVisibilityChange);
  if (pollTimer) clearTimeout(pollTimer);
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const busy = ref<string | null>(null); // tracks which action is running
const actionError = ref("");
const actionOk = ref("");

async function doAction(label: string, fn: () => Promise<void>) {
  busy.value = label;
  actionError.value = "";
  actionOk.value = "";
  try {
    await fn();
    actionOk.value = `${label} สำเร็จ`;
    await fetchDeployments();
    schedulePoll();
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : "เกิดข้อผิดพลาด";
  } finally {
    busy.value = null;
  }
}

async function deploy() {
  await doAction("Deploy", async () => {
    const { error } = await api.api.v1.projects({ id: props.projectId }).deploy.post({});
    if (error)
      throw new Error(
        (error.value as { error?: { message?: string } } | null)?.error?.message ?? "deploy ล้มเหลว",
      );
  });
}

async function redeploy() {
  await doAction("Redeploy", async () => {
    const { error } = await api.api.v1.projects({ id: props.projectId }).redeploy.post({});
    if (error)
      throw new Error(
        (error.value as { error?: { message?: string } } | null)?.error?.message ??
          "redeploy ล้มเหลว",
      );
  });
}

async function restart() {
  await doAction("Restart", async () => {
    const { error } = await api.api.v1.projects({ id: props.projectId }).restart.post({});
    if (error)
      throw new Error(
        (error.value as { error?: { message?: string } } | null)?.error?.message ??
          "restart ล้มเหลว",
      );
  });
}

async function stop() {
  await doAction("Stop", async () => {
    const { error } = await api.api.v1.projects({ id: props.projectId }).stop.post({});
    if (error)
      throw new Error(
        (error.value as { error?: { message?: string } } | null)?.error?.message ?? "stop ล้มเหลว",
      );
  });
}

async function rollback(targetDeploymentId: string) {
  await doAction("Rollback", async () => {
    const { error } = await api.api.v1
      .projects({ id: props.projectId })
      .rollback.post({ targetDeploymentId });
    if (error)
      throw new Error(
        (error.value as { error?: { message?: string } } | null)?.error?.message ??
          "rollback ล้มเหลว",
      );
  });
}

// ---------------------------------------------------------------------------
// ลบประวัติ
// ---------------------------------------------------------------------------

const deletingId = ref<string | null>(null);
const confirmPrune = ref(false);
const pruning = ref(false);

/**
 * ลบรายการเดียว
 *
 * API ปฏิเสธเองถ้าเป็นตัวที่ให้บริการอยู่หรือกำลังทำงาน — ไม่ซ่อนปุ่มไว้ล่วงหน้า
 * แต่แสดงข้อความจาก server เพราะเงื่อนไข "ตัวไหน active" เปลี่ยนได้ระหว่างที่เปิดหน้าอยู่
 */
async function removeDeployment(id: string) {
  deletingId.value = id;
  actionError.value = "";
  actionOk.value = "";
  try {
    const { error } = await api.api.v1
      .projects({ id: props.projectId })
      .deployments({ deploymentId: id })
      .delete();
    if (error) {
      actionError.value =
        (error.value as { error?: { message?: string } } | null)?.error?.message ?? "ลบไม่สำเร็จ";
      return;
    }
    // cursor เดิมอาจชี้ไปยังแถวที่เพิ่งหายไป — กลับหน้าแรกแทนการโหลดหน้าเดิมซ้ำ
    await resetToFirstPage();
    actionOk.value = "ลบแล้ว";
  } catch {
    actionError.value = "ติดต่อ API ไม่ได้";
  } finally {
    deletingId.value = null;
  }
}

async function pruneHistory() {
  pruning.value = true;
  actionError.value = "";
  actionOk.value = "";
  try {
    const { data, error } = await api.api.v1
      .projects({ id: props.projectId })
      .deployments.prune.post({});
    if (error) {
      actionError.value =
        (error.value as { error?: { message?: string } } | null)?.error?.message ??
        "ล้างประวัติไม่สำเร็จ";
      return;
    }
    confirmPrune.value = false;
    await resetToFirstPage();

    const skipped = data?.skipped?.length ?? 0;
    actionOk.value =
      skipped > 0
        ? `ลบ ${data?.deleted ?? 0} รายการ — เหลือไว้ ${skipped} รายการที่ลบไม่ได้ (ให้บริการอยู่หรือกำลังทำงาน)`
        : `ลบประวัติ ${data?.deleted ?? 0} รายการแล้ว`;
  } catch {
    actionError.value = "ติดต่อ API ไม่ได้";
  } finally {
    pruning.value = false;
  }
}

async function cancel(deploymentId: string) {
  await doAction("Cancel", async () => {
    const { error } = await api.api.v1.deployments({ id: deploymentId }).cancel.post({});
    if (error)
      throw new Error(
        (error.value as { error?: { message?: string } } | null)?.error?.message ?? "cancel ล้มเหลว",
      );
  });
}

function fmtDuration(start: number | null, end: number | null) {
  if (!start || !end) return null;
  const s = Math.round((end - start) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
</script>

<template>
  <div class="stack-lg">
    <!-- Action buttons -->
    <div class="stack">
      <div v-if="!archived" class="actions">
        <button class="primary" :disabled="!!busy || !hasSource" @click="deploy">
          <span v-if="busy === 'Deploy'" class="spinner" />
          <AppIcon v-else name="rotate" :size="15" />
          {{ busy === "Deploy" ? "กำลัง deploy…" : "Deploy" }}
        </button>
        <!-- โชว์ sha บนปุ่มกันเข้าใจผิดว่า Redeploy จะได้โค้ดใหม่ — มันคือ build ซ้ำ commit เดิม -->
        <button
          class="secondary"
          :disabled="!!busy || deployments.length === 0"
          :title="latestDeployment
            ? `build ซ้ำ commit ${shortSha(latestDeployment.commitSha)} เดิม — ไม่ดึงโค้ดล่าสุดจาก branch (ถ้าเพิ่ง push โค้ดใหม่ให้ใช้ Deploy)`
            : undefined"
          @click="redeploy"
        >
          <span v-if="busy === 'Redeploy'" class="spinner" />
          <template v-if="busy === 'Redeploy'">กำลัง…</template>
          <template v-else-if="latestDeployment">
            Redeploy <span class="mono">{{ shortSha(latestDeployment.commitSha) }}</span>
          </template>
          <template v-else>Redeploy</template>
        </button>
        <button class="secondary" :disabled="!!busy" @click="restart">
          <span v-if="busy === 'Restart'" class="spinner" />
          {{ busy === "Restart" ? "กำลัง…" : "Restart" }}
        </button>
        <button class="danger" :disabled="!!busy" @click="stop">
          <span v-if="busy === 'Stop'" class="spinner" />
          <AppIcon v-else name="stop" :size="14" />
          {{ busy === "Stop" ? "กำลัง…" : "Stop" }}
        </button>
      </div>
      <p v-if="!hasSource" class="alert alert-warn">
        <AppIcon name="alert" :size="15" />
        <span>ตั้งค่า Source repository ก่อนจึงจะ Deploy ได้</span>
      </p>

      <p v-if="actionError" class="alert alert-bad">
        <AppIcon name="alert" :size="15" />
        <span>{{ actionError }}</span>
      </p>
      <p v-if="actionOk" class="alert alert-ok">
        <AppIcon name="check" :size="15" />
        <span>{{ actionOk }}</span>
      </p>
    </div>

    <!-- ── Auto deploy ── (เฉพาะ source แบบ GitHub — dockerfile-paste ไม่มี push event ให้ฟัง)
         อยู่ตรงนี้ไม่ใช่ในแท็บตั้งค่า เพราะเป็นสิ่งที่คนดูเวลาสงสัยว่า "ทำไม push แล้วไม่ deploy" -->
    <section v-if="autoDeploySupported" class="inset auto-deploy">
      <div class="ad-main">
        <button
          class="switch"
          role="switch"
          :aria-checked="autoDeployLocal"
          :disabled="savingAutoDeploy || archived || !hasSource"
          @click="toggleAutoDeploy"
        >
          <span class="switch-track" :class="{ on: autoDeployLocal }">
            <span class="switch-thumb" />
          </span>
        </button>

        <div class="ad-text">
          <span class="ad-title">
            Auto deploy
            <span class="badge tiny" :class="autoDeployLocal ? 'tone-ok' : 'tone-idle'">
              {{ autoDeployLocal ? "เปิด" : "ปิด" }}
            </span>
            <span v-if="savingAutoDeploy" class="spinner" />
          </span>
          <span class="muted tiny">
            <template v-if="autoDeployLocal">
              push เข้า <code>{{ branch ?? "—" }}</code> แล้วระบบจะ build และ deploy ให้อัตโนมัติ
            </template>
            <template v-else>
              ตอนนี้ push เข้า <code>{{ branch ?? "—" }}</code> จะ<strong>ไม่</strong>ทำอะไร —
              ต้องกด Deploy เอง
            </template>
          </span>
        </div>
      </div>

      <p v-if="!hasSource" class="field-hint">เชื่อม repository ก่อนจึงจะเปิด auto deploy ได้</p>
      <p v-if="autoDeployError" class="alert alert-bad tiny">
        <AppIcon name="alert" :size="14" />
        <span>{{ autoDeployError }}</span>
      </p>
    </section>

    <!-- env เปลี่ยนหลัง deploy ล่าสุด — ค่าใหม่ยังไม่มีผลจนกว่าจะ deploy อีกครั้ง
         (บทเรียนจริง: แก้ env แล้วลืมกด Deploy โดยไม่มีอะไรเตือนเลย) -->
    <p v-if="!archived && envChangedAfterDeploy" class="alert alert-warn">
      <AppIcon name="alert" :size="15" />
      <span>
        มีการแก้ environment variables หลัง deploy ล่าสุด — ค่าที่รันอยู่ยังเป็นชุดเก่า
        กด <strong>Deploy</strong> เพื่อให้ค่าใหม่มีผล
      </span>
    </p>

    <!-- Deployment list -->
    <div>
      <div class="row-between section-head">
        <h2 class="section-title">
          ประวัติ Deployment
          <span v-if="total > 0" class="badge tiny">{{ total }}</span>
        </h2>
        <span class="spacer" />
        <button
          v-if="!archived && total > 0"
          class="danger small"
          :disabled="pruning || loadingList"
          @click="confirmPrune = true"
        >
          <AppIcon name="trash" :size="13" />
          ล้างประวัติ
        </button>
        <button
          class="ghost small icon"
          :disabled="loadingList"
          title="รีเฟรช"
          aria-label="รีเฟรช"
          @click="resetToFirstPage()"
        >
          <AppIcon name="refresh" :size="14" />
        </button>
      </div>

      <div v-if="loadingList" class="stack">
        <span class="skeleton" style="height: 64px" />
        <span class="skeleton" style="height: 64px" />
      </div>
      <p v-else-if="listError" class="alert alert-bad">
        <AppIcon name="alert" :size="15" />
        <span>{{ listError }}</span>
      </p>
      <div v-else-if="deployments.length === 0" class="empty">
        <span class="empty-icon"><AppIcon name="rotate" :size="20" /></span>
        <span class="empty-title">ยังไม่เคย deploy</span>
      </div>

      <ul v-else class="deploy-list">
        <li v-for="d in deployments" :key="d.id" class="inset deploy-item">
          <div class="deploy-header">
            <span class="status" :class="`status-${d.status}`">{{ d.status }}</span>
            <code class="mono small">{{ shortSha(d.commitSha) }}</code>
            <span class="meta muted small">{{ d.trigger }}</span>
            <span class="meta muted small" :title="fullDateTime(d.queuedAt)">
              {{ timeAgo(d.queuedAt) }}
            </span>
            <span v-if="fmtDuration(d.startedAt, d.finishedAt)" class="meta muted small">
              <AppIcon name="clock" :size="11" />
              {{ fmtDuration(d.startedAt, d.finishedAt) }}
            </span>
          </div>

          <p v-if="d.commitMessage" class="commit-msg truncate">{{ d.commitMessage }}</p>

          <p v-if="d.status === 'failed' && d.failureMessage" class="alert alert-bad small">
            <AppIcon name="alert" :size="13" />
            <span>{{ d.failureCode }}: {{ d.failureMessage }}</span>
          </p>

          <div v-if="!archived" class="deploy-item-actions">
            <button
              v-if="IN_FLIGHT.includes(d.status)"
              class="danger tiny"
              :disabled="!!busy"
              @click="cancel(d.id)"
            >
              Cancel
            </button>
            <button
              v-if="d.status === 'succeeded'"
              class="secondary tiny"
              :disabled="!!busy"
              @click="rollback(d.id)"
            >
              Rollback
            </button>

            <span class="spacer" />

            <!-- ปุ่มลบแสดงทุกแถว — API เป็นผู้ตัดสินว่าลบได้ไหม เพราะเงื่อนไข
                 "ตัวไหนกำลังให้บริการ" เปลี่ยนได้ระหว่างที่เปิดหน้าอยู่ -->
            <button
              class="ghost tiny delete-btn"
              :disabled="!!busy || deletingId === d.id"
              title="ลบรายการนี้"
              @click="removeDeployment(d.id)"
            >
              <span v-if="deletingId === d.id" class="spinner" />
              <AppIcon v-else name="trash" :size="12" />
            </button>
          </div>
        </li>
      </ul>

      <!-- Pagination -->
      <div v-if="!loadingList && total > 0" class="pager">
        <span class="muted tiny">
          แสดง {{ rangeStart }}–{{ rangeEnd }} จาก {{ total }}
        </span>
        <span class="spacer" />
        <button class="secondary small" :disabled="pageIndex === 0" @click="goPrev">
          <AppIcon name="arrowLeft" :size="13" />
          ก่อนหน้า
        </button>
        <span class="muted tiny page-num">{{ pageIndex + 1 }} / {{ totalPages }}</span>
        <button class="secondary small" :disabled="!nextCursor" @click="goNext">
          ถัดไป
          <AppIcon name="chevronRight" :size="13" />
        </button>
      </div>
    </div>

    <ConfirmDialog
      :open="confirmPrune"
      title="ล้างประวัติ Deployment"
      message="ลบประวัติทั้งหมดพร้อม build log — ยกเว้นเวอร์ชันที่ให้บริการอยู่และรายการที่กำลังทำงาน ซึ่งจะถูกเก็บไว้ให้อัตโนมัติ ไม่กระทบแอปที่รันอยู่"
      confirm-label="ล้างประวัติ"
      :busy="pruning"
      @cancel="confirmPrune = false"
      @confirm="pruneHistory"
    />
  </div>
</template>

<style scoped>
/* ── Auto deploy switch ── */
.auto-deploy {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.ad-main {
  display: flex;
  align-items: flex-start;
  gap: var(--s-3);
}
.ad-text {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}
.ad-title {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  font-weight: 600;
  font-size: var(--t-sm);
}

/* สวิตช์เอง — ปุ่มโปร่งใสครอบ track เพื่อให้พื้นที่คลิกใหญ่กว่าตัวสวิตช์ */
.switch {
  height: auto;
  padding: 2px;
  background: transparent;
  border: none;
  box-shadow: none;
  flex-shrink: 0;
}
.switch:hover:not(:disabled) {
  background: transparent;
}
.switch:disabled {
  opacity: 0.45;
}
.switch-track {
  display: block;
  width: 38px;
  height: 22px;
  border-radius: var(--r-full);
  background: var(--surface-3);
  border: 1px solid var(--border-strong);
  position: relative;
  transition:
    background var(--fast),
    border-color var(--fast);
}
.switch-track.on {
  background: var(--accent);
  border-color: var(--accent);
}
.switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--text);
  transition: transform var(--fast);
  box-shadow: var(--shadow-sm);
}
.switch-track.on .switch-thumb {
  transform: translateX(16px);
  background: var(--accent-fg);
}

/* ── Pagination ── */
.pager {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
  padding-top: var(--s-3);
  border-top: 1px solid var(--border-subtle);
}
.page-num {
  min-width: 3.5em;
  text-align: center;
}

/* ปุ่มลบจางไว้ก่อน ชัดขึ้นเมื่อ hover การ์ด — ไม่ให้แย่งสายตาจาก Rollback/Cancel */
.delete-btn {
  color: var(--text-faint);
  opacity: 0.6;
  transition:
    opacity var(--fast),
    color var(--fast);
}
.deploy-item:hover .delete-btn {
  opacity: 1;
}
.delete-btn:hover:not(:disabled) {
  color: var(--bad);
  background: var(--bad-tint);
}

.section-head {
  margin-bottom: var(--s-3);
}

.deploy-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.deploy-item {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.deploy-header {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  flex-wrap: wrap;
}
.meta {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
.commit-msg {
  margin: 0;
  font-size: var(--t-sm);
  color: var(--text-secondary);
}
.deploy-item-actions {
  display: flex;
  gap: var(--s-2);
}
.load-more {
  margin-top: var(--s-3);
}
</style>
