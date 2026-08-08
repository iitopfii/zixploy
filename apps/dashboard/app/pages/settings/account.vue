<script setup lang="ts">
/**
 * ตั้งค่าบัญชี — เปลี่ยนรหัสผ่าน
 *
 * API ออก session ใหม่ให้เครื่องนี้พร้อมกับ revoke ที่เหลือ จึงไม่ต้อง redirect
 * ไป login ใหม่ — แค่บอกผู้ใช้ว่าอุปกรณ์อื่นถูกออกจากระบบแล้ว
 */
const api = useApi();
const session = useSession();

const form = reactive({ current: "", next: "", confirm: "" });
const show = reactive({ current: false, next: false });

const saving = ref(false);
const errorMsg = ref("");
const okMsg = ref("");

const MIN_LENGTH = 12;

/** ตรวจฝั่ง client เพื่อบอกทันทีที่พิมพ์ — server ตรวจซ้ำเสมออยู่แล้ว */
const problem = computed(() => {
  if (!form.current) return "ต้องกรอกรหัสผ่านปัจจุบัน";
  if (form.next.length < MIN_LENGTH) return `รหัสผ่านใหม่ต้องยาวอย่างน้อย ${MIN_LENGTH} ตัวอักษร`;
  if (form.next === form.current) return "รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม";
  if (form.confirm && form.next !== form.confirm) return "ยืนยันรหัสผ่านไม่ตรงกัน";
  if (!form.confirm) return "ต้องยืนยันรหัสผ่านใหม่";
  return null;
});

/** ความแข็งแรงคร่าว ๆ — บอกทิศทาง ไม่ได้บังคับ (บังคับแค่ความยาวขั้นต่ำ) */
const strength = computed(() => {
  const p = form.next;
  if (!p) return null;
  let score = 0;
  if (p.length >= MIN_LENGTH) score++;
  if (p.length >= 16) score++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++;
  if (/\d/.test(p)) score++;
  if (/[^A-Za-z0-9]/.test(p)) score++;

  if (score <= 2) return { label: "อ่อน", tone: "bad", pct: 33 };
  if (score <= 3) return { label: "พอใช้", tone: "warn", pct: 66 };
  return { label: "แข็งแรง", tone: "ok", pct: 100 };
});

async function submit() {
  if (problem.value) return;
  saving.value = true;
  errorMsg.value = "";
  okMsg.value = "";
  try {
    const { data, error } = await api.api.v1.auth["change-password"].post({
      currentPassword: form.current,
      newPassword: form.next,
    });
    if (error) {
      const body = error.value as { error?: { message?: string } } | null;
      errorMsg.value = body?.error?.message ?? "เปลี่ยนรหัสผ่านไม่สำเร็จ";
      return;
    }
    // session ใหม่มากับ response แล้ว — อัปเดต state ให้ตรง ไม่ต้อง login ซ้ำ
    if (data) session.value = data;
    form.current = "";
    form.next = "";
    form.confirm = "";
    okMsg.value = "เปลี่ยนรหัสผ่านแล้ว — อุปกรณ์อื่นทั้งหมดถูกออกจากระบบ";
  } catch {
    errorMsg.value = "ติดต่อ API ไม่ได้";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="stack-lg">
    <header>
      <h1>บัญชีผู้ใช้</h1>
      <p class="muted small">จัดการข้อมูลการเข้าสู่ระบบของคุณ</p>
    </header>

    <section class="card stack">
      <div>
        <h2 class="section-title">ข้อมูลบัญชี</h2>
        <dl class="kv account-kv">
          <dt>ชื่อผู้ใช้</dt>
          <dd>{{ session.username ?? "—" }}</dd>
        </dl>
      </div>
    </section>

    <form class="card stack" @submit.prevent="submit">
      <div>
        <h2 class="section-title">เปลี่ยนรหัสผ่าน</h2>
        <p class="muted small hint">
          หลังเปลี่ยนแล้ว อุปกรณ์อื่นที่ล็อกอินค้างไว้จะถูกออกจากระบบทั้งหมด
          ส่วนเครื่องนี้ยังใช้งานต่อได้ตามปกติ
        </p>
      </div>

      <label>
        <span>รหัสผ่านปัจจุบัน</span>
        <div class="pw-field">
          <input
            v-model="form.current"
            :type="show.current ? 'text' : 'password'"
            autocomplete="current-password"
            :disabled="saving"
          />
          <button
            type="button"
            class="ghost small pw-toggle"
            tabindex="-1"
            :aria-label="show.current ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'"
            @click="show.current = !show.current"
          >
            {{ show.current ? "ซ่อน" : "แสดง" }}
          </button>
        </div>
      </label>

      <label>
        <span>รหัสผ่านใหม่</span>
        <div class="pw-field">
          <input
            v-model="form.next"
            :type="show.next ? 'text' : 'password'"
            autocomplete="new-password"
            :disabled="saving"
          />
          <button
            type="button"
            class="ghost small pw-toggle"
            tabindex="-1"
            :aria-label="show.next ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'"
            @click="show.next = !show.next"
          >
            {{ show.next ? "ซ่อน" : "แสดง" }}
          </button>
        </div>

        <div v-if="strength" class="strength">
          <div class="bar">
            <div class="fill" :class="`s-${strength.tone}`" :style="{ width: `${strength.pct}%` }" />
          </div>
          <span class="tiny" :class="`text-${strength.tone}`">{{ strength.label }}</span>
        </div>
        <span class="field-hint">อย่างน้อย {{ MIN_LENGTH }} ตัวอักษร</span>
      </label>

      <label>
        <span>ยืนยันรหัสผ่านใหม่</span>
        <input
          v-model="form.confirm"
          type="password"
          autocomplete="new-password"
          :disabled="saving"
        />
      </label>

      <p v-if="errorMsg" class="alert alert-bad">
        <AppIcon name="alert" :size="15" />
        <span>{{ errorMsg }}</span>
      </p>
      <p v-if="okMsg" class="alert alert-ok">
        <AppIcon name="check" :size="15" />
        <span>{{ okMsg }}</span>
      </p>

      <div class="actions-end">
        <span v-if="problem && (form.current || form.next)" class="muted tiny problem">
          {{ problem }}
        </span>
        <button class="primary" type="submit" :disabled="saving || !!problem">
          <span v-if="saving" class="spinner" />
          {{ saving ? "กำลังบันทึก…" : "เปลี่ยนรหัสผ่าน" }}
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
h1 {
  margin-bottom: 0.15rem;
}
.hint {
  margin-top: 0.25rem;
  max-width: 60ch;
}
.account-kv {
  margin-top: var(--s-3);
}

form label {
  margin: 0;
}

.pw-field {
  position: relative;
  display: flex;
  align-items: center;
}
.pw-field input {
  padding-right: 4rem;
}
.pw-toggle {
  position: absolute;
  right: 4px;
  height: 26px;
  color: var(--text-muted);
}

/* ── ตัววัดความแข็งแรง ── */
.strength {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  margin-top: var(--s-2);
}
.bar {
  flex: 1;
  height: 4px;
  border-radius: var(--r-full);
  background: var(--surface-3);
  overflow: hidden;
}
.fill {
  height: 100%;
  border-radius: var(--r-full);
  transition: width var(--normal), background var(--normal);
}
.s-bad {
  background: var(--bad);
}
.s-warn {
  background: var(--warn);
}
.s-ok {
  background: var(--ok);
}
.text-bad {
  color: var(--bad);
}
.text-warn {
  color: var(--warn);
}
.text-ok {
  color: var(--ok);
}

.actions-end {
  align-items: center;
}
.problem {
  margin-right: auto;
}
</style>
