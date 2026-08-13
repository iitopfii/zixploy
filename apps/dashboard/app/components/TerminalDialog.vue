<script setup lang="ts">
/**
 * Interactive terminal เข้า container ของ managed database — Phase 17
 *
 * โครง dialog ก็อปจาก ServiceLogsDialog.vue (backdrop/Teleport/header เดียวกัน) แต่แทนที่ SSE
 * ด้วย WebSocket ดิบที่คุย xterm.js กับ control-api ตรง ๆ (relay ต่อไปหา worker เอง — ดู
 * TERMINAL_SETTINGS ใน internal/shared/src/constants.ts สำหรับ message framing เต็ม ๆ):
 * - binary frame = terminal I/O byte ดิบ ทั้งสองทิศทาง
 * - text frame   = JSON control message ทิศทาง browser → server เท่านั้น เช่น resize
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

const props = defineProps<{ serviceId: string; serviceName: string }>();
const emit = defineEmits<{ close: [] }>();

const termEl = ref<HTMLElement | null>(null);

let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let ws: WebSocket | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
// ยังไม่เคยได้ byte จาก server เลย — ใช้แยกว่า close ที่ผิดปกติเกิด "ก่อน" หรือ "หลัง"
// เซสชันเริ่มคุยกันได้จริง (ก่อน = worker/relay มีปัญหา, หลัง = เชื่อมต่อหลุดกลางคัน)
let receivedAny = false;

type ConnState = "connecting" | "live" | "ended" | "error";
const connState = ref<ConnState>("connecting");
const connError = ref("");

const RESIZE_DEBOUNCE_MS = 200;

function wsUrl(): string {
  const origin = useRequestURL().origin.replace(/^http/, "ws");
  return `${origin}/api/v1/services/${props.serviceId}/terminal`;
}

function sendResize() {
  if (!terminal || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
}

function fitAndSendResize() {
  if (!fitAddon) return;
  try {
    fitAddon.fit();
  } catch {
    // container อาจมีขนาด 0 ชั่วครู่ระหว่าง teleport เพิ่งต่อ DOM — ข้ามรอบนี้ไปเฉย ๆ
    return;
  }
  sendResize();
}

function scheduleFit() {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fitAndSendResize, RESIZE_DEBOUNCE_MS);
}

function connect() {
  const socket = new WebSocket(wsUrl());
  socket.binaryType = "arraybuffer";
  ws = socket;

  socket.onopen = () => {
    connState.value = "live";
    // ส่งขนาดปัจจุบันทันที — worker ต้อง resize pty ก่อน exec shell ถึงจะพอดีจอ
    sendResize();
  };

  socket.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      receivedAny = true;
      terminal?.write(new Uint8Array(ev.data));
      return;
    }
    // text frame จาก server ไม่อยู่ใน protocol ปัจจุบัน (browser → server เท่านั้น) — เมิน ไม่ throw
  };

  socket.onclose = (ev) => {
    ws = null;
    if (ev.code === 1000) {
      connState.value = "ended";
      terminal?.write("\r\n\r\n[session ended]\r\n");
      return;
    }
    connState.value = "error";
    connError.value = ev.reason || "เชื่อมต่อ terminal ไม่สำเร็จ";
    if (receivedAny) {
      terminal?.write(`\r\n\r\n[connection lost${ev.reason ? `: ${ev.reason}` : ""}]\r\n`);
    }
  };

  // onclose ยิงตามหลัง onerror เสมอพร้อม code/reason ครบกว่า — ไม่ต้อง handle ซ้ำที่นี่
  socket.onerror = () => {};
}

onMounted(() => {
  if (!termEl.value) return;

  terminal = new Terminal({
    convertEol: true,
    fontFamily:
      '"JetBrains Mono", "SF Mono", ui-monospace, "Cascadia Code", Menlo, Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: {
      background: "#0e1117",
      foreground: "#e8eaf0",
      cursor: "#5b8cff",
      cursorAccent: "#05080f",
      selectionBackground: "rgba(91, 140, 255, 0.28)",
      black: "#12151d",
      red: "#ff6b6b",
      green: "#3ddc97",
      yellow: "#f5b642",
      blue: "#5b8cff",
      magenta: "#c792ea",
      cyan: "#7dd3fc",
      white: "#a8b0c2",
      brightBlack: "#4d5566",
      brightRed: "#ff8a8a",
      brightGreen: "#5eeab0",
      brightYellow: "#ffcb6b",
      brightBlue: "#7aa2ff",
      brightMagenta: "#ddb0f5",
      brightCyan: "#a5e8ff",
      brightWhite: "#e8eaf0",
    },
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(termEl.value);
  fitAddon.fit();

  terminal.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(new TextEncoder().encode(data));
    }
  });

  window.addEventListener("resize", scheduleFit);
  connect();
});

onUnmounted(() => {
  window.removeEventListener("resize", scheduleFit);
  if (resizeTimer) clearTimeout(resizeTimer);
  if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, "dialog closed");
  ws = null;
  terminal?.dispose();
  terminal = null;
  fitAddon = null;
});
</script>

<template>
  <Teleport to="body">
    <div class="backdrop" @click.self="emit('close')">
      <div class="dialog card" role="dialog" aria-modal="true">
        <div class="row-between">
          <h2 class="section-title truncate">Terminal — {{ serviceName }}</h2>
          <button class="ghost icon small" aria-label="ปิด" @click="emit('close')">
            <AppIcon name="x" :size="15" />
          </button>
        </div>

        <div class="toolbar">
          <span v-if="connState === 'connecting'" class="status status-starting">
            <span class="spinner" />
            กำลังเชื่อมต่อ…
          </span>
          <span v-else-if="connState === 'live'" class="status status-running is-live">LIVE</span>
          <span v-else-if="connState === 'ended'" class="status status-stopped">จบเซสชันแล้ว</span>
          <span v-else class="status status-failed">เชื่อมต่อไม่สำเร็จ</span>
        </div>

        <p v-if="connState === 'error'" class="alert alert-bad small">
          <AppIcon name="alert" :size="14" />
          <span>{{ connError }}</span>
        </p>

        <div ref="termEl" class="term-box" />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dialog {
  width: min(760px, 92vw);
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  flex-wrap: wrap;
}

.status .spinner {
  width: 10px;
  height: 10px;
}

/* xterm.js จัดการ scroll ภายในตัวเอง (.xterm-viewport) — กล่องนอกต้อง overflow: hidden
   ไม่งั้น scroll ซ้อนสองชั้นและ FitAddon คำนวณขนาดผิด */
.term-box {
  height: 420px;
  overflow: hidden;
  background: #0e1117;
  border: 1px solid var(--border);
  border-radius: var(--r);
  padding: var(--s-2);
}

.term-box :deep(.xterm) {
  height: 100%;
}
</style>
