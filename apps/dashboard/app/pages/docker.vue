<script setup lang="ts">
/**
 * Docker inventory — รายชื่อ container/image ทั้งเครื่อง
 *
 * ข้อมูลมาจาก /system/docker ซึ่งอ่าน snapshot ที่ deploy-worker กวาดไว้ทุก ~30 วิ
 * (control-api ไม่แตะ Docker เอง) — หน้านี้อ่านอย่างเดียว ไม่มีปุ่มสั่ง start/stop/ลบ
 */
const api = useApi();

const { data, pending, error, refresh } = await useAsyncData(
  "docker-inventory",
  async () => {
    const { data: body, error: apiError } = await api.api.v1.system.docker.get();
    if (apiError) throw new Error("โหลด docker inventory ไม่สำเร็จ");
    return body;
  },
  { server: false },
);

// รีเฟรชอัตโนมัติเท่าความถี่ที่ worker กวาดจริง
onMounted(() => {
  const timer = setInterval(() => refresh(), 30_000);
  onUnmounted(() => clearInterval(timer));
});

const tab = ref<"containers" | "images">("containers");
const filter = ref("");

const containers = computed(() => {
  const list = data.value?.containers ?? [];
  const q = filter.value.trim().toLowerCase();
  if (!q) return list;
  return list.filter((c) => c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q));
});

const images = computed(() => {
  const list = data.value?.images ?? [];
  const q = filter.value.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (i) => i.repository.toLowerCase().includes(q) || i.tag.toLowerCase().includes(q),
  );
});

const runningCount = computed(
  () => (data.value?.containers ?? []).filter((c) => c.state === "running").length,
);

const STATE_TONE: Record<string, string> = {
  running: "tone-ok",
  exited: "tone-idle",
  created: "tone-idle",
  paused: "tone-warn",
  restarting: "tone-warn",
  dead: "tone-bad",
};
function stateTone(state: string) {
  return STATE_TONE[state] ?? "tone-idle";
}
</script>

<template>
  <div class="stack-lg">
    <header class="page-head">
      <div>
        <h1>Docker</h1>
        <p class="muted small">
          container และ image ทั้งหมดบนเซิร์ฟเวอร์ (อ่านอย่างเดียว)
        </p>
      </div>
      <div class="actions">
        <span v-if="data?.capturedAt" class="muted small" :title="fullDateTime(data.capturedAt)">
          อัปเดต {{ timeAgo(data.capturedAt) }}
        </span>
        <button class="secondary icon" title="โหลดใหม่" aria-label="โหลดใหม่" @click="refresh()">
          <AppIcon name="rotate" :size="15" />
        </button>
      </div>
    </header>

    <!-- Loading (ครั้งแรก) -->
    <div v-if="pending && !data" class="stack">
      <span class="skeleton" style="height: 36px" />
      <span class="skeleton" style="height: 200px" />
    </div>

    <p v-else-if="error" class="alert alert-bad">
      <AppIcon name="alert" :size="15" />
      <span>โหลดข้อมูลไม่สำเร็จ — ลองโหลดใหม่</span>
    </p>

    <!-- worker ยังไม่เคยกวาด (เพิ่งติดตั้ง/worker ไม่ทำงาน) -->
    <div v-else-if="!data?.capturedAt" class="card">
      <div class="empty">
        <span class="empty-icon"><AppIcon name="box" :size="20" /></span>
        <span class="empty-title">ยังไม่มีข้อมูล</span>
        <p class="small">
          รอ worker เก็บข้อมูลรอบแรก (~30 วินาที) — ถ้าค้างนาน ตรวจว่า deploy-worker ทำงานอยู่
        </p>
      </div>
    </div>

    <template v-else>
      <div class="row-between wrap">
        <nav class="tabs" aria-label="ประเภทข้อมูล">
          <button
            class="tab"
            :class="{ active: tab === 'containers' }"
            @click="tab = 'containers'"
          >
            Containers
            <span class="count">{{ data.containers.length }}</span>
          </button>
          <button class="tab" :class="{ active: tab === 'images' }" @click="tab = 'images'">
            Images
            <span class="count">{{ data.images.length }}</span>
          </button>
        </nav>
        <input
          v-model="filter"
          class="filter-input"
          type="search"
          placeholder="ค้นหาชื่อ / image…"
        />
      </div>

      <!-- ── Containers ── -->
      <div v-if="tab === 'containers'" class="card stack">
        <p class="muted small">
          ทำงานอยู่ {{ runningCount }} จาก {{ data.containers.length }} container
        </p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ชื่อ</th>
                <th>สถานะ</th>
                <th>Image</th>
                <th>Ports</th>
                <th>ที่มา</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in containers" :key="c.containerId">
                <td>
                  <div class="cell-main mono">{{ c.name }}</div>
                  <div class="cell-sub mono muted">{{ c.containerId }}</div>
                </td>
                <td>
                  <span class="badge" :class="stateTone(c.state)">{{ c.state }}</span>
                  <div class="cell-sub muted">{{ c.status }}</div>
                </td>
                <td class="mono small">{{ c.image }}</td>
                <td class="mono small">{{ c.ports ?? "—" }}</td>
                <td>
                  <span class="badge" :class="c.managed ? 'tone-ok' : 'tone-idle'">
                    {{ c.managed ? "Zixploy" : "อื่น ๆ" }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="containers.length === 0" class="muted small">ไม่พบ container ที่ตรงกับคำค้น</p>
      </div>

      <!-- ── Images ── -->
      <div v-else class="card stack">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Repository</th>
                <th>Tag</th>
                <th>Image ID</th>
                <th>ขนาด</th>
                <th>สร้างเมื่อ</th>
                <th>ที่มา</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="i in images" :key="`${i.imageId}-${i.repository}-${i.tag}`">
                <td class="mono">{{ i.repository }}</td>
                <td class="mono small">{{ i.tag }}</td>
                <td class="mono small muted">{{ i.imageId }}</td>
                <td class="small">{{ i.size ?? "—" }}</td>
                <td class="small muted">{{ i.createdSince ?? "—" }}</td>
                <td>
                  <span class="badge" :class="i.managed ? 'tone-ok' : 'tone-idle'">
                    {{ i.managed ? "Zixploy" : "อื่น ๆ" }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="images.length === 0" class="muted small">ไม่พบ image ที่ตรงกับคำค้น</p>
      </div>

      <p class="muted small note">
        <AppIcon name="info" :size="13" />
        รายการนี้เป็น snapshot ที่ worker กวาดทุก ~30 วินาที — image ที่ไม่ได้ใช้ลบได้ที่
        Monitoring → ล้างพื้นที่
      </p>
    </template>
  </div>
</template>

<style scoped>
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s-4);
  flex-wrap: wrap;
}
.page-head p {
  margin-top: 0.15rem;
}
.actions {
  display: flex;
  align-items: center;
  gap: var(--s-3);
}

/* segmented tabs — โครงเดียวกับแท็บในหน้า project */
.tabs {
  display: flex;
  gap: 2px;
  padding: 3px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r);
}
.tab {
  height: 30px;
  padding: 0 var(--s-3);
  border: none;
  background: transparent;
  box-shadow: none;
  color: var(--text-muted);
  font-size: var(--t-sm);
  border-radius: var(--r-sm);
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.tab:hover:not(.active) {
  background: var(--surface-2);
  color: var(--text-secondary);
}
.tab.active {
  background: var(--surface-3);
  color: var(--text);
  font-weight: 550;
  box-shadow: var(--shadow-sm);
}
.count {
  font-size: var(--t-xs);
  padding: 0.05rem 0.4rem;
  background: var(--surface-2);
  border-radius: 999px;
  color: var(--text-muted);
}
.tab.active .count {
  background: var(--surface-1);
}

.filter-input {
  max-width: 240px;
}

/* ── ตาราง ── */
.table-wrap {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--t-sm);
}
th {
  text-align: left;
  padding: var(--s-2) var(--s-3);
  font-size: var(--t-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-subtle);
  white-space: nowrap;
}
td {
  padding: var(--s-2) var(--s-3);
  border-bottom: 1px solid var(--border-subtle);
  vertical-align: top;
}
tbody tr:last-child td {
  border-bottom: none;
}
tbody tr:hover {
  background: var(--surface-2);
}
.cell-main {
  font-weight: 550;
}
.cell-sub {
  font-size: var(--t-xs);
  margin-top: 0.15rem;
}

.note {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
</style>
