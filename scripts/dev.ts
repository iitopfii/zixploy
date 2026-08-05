/**
 * เปิด local development stack ด้วยคำสั่งเดียว: `bun run dev`
 *
 * รัน Control API, Deploy Worker และ Dashboard เป็น subprocess ของ Bun
 * (ไม่ containerize เพราะ dev loop ด้วย Bun เร็วกว่าและ debug ง่ายกว่า)
 *
 * Traefik เปิดแยกด้วย `bun run dev:proxy` เพราะต้องใช้ Docker daemon
 * และไม่จำเป็นสำหรับงาน Phase 1
 *
 * สำคัญ: **ไม่มี** service ใดในนี้ได้รับสิทธิ์ Docker socket — Control API
 * ห้ามแตะ Docker เด็ดขาด (ADR-0002) ส่วน worker จะได้สิทธิ์ใน Phase 3
 */
import type { Subprocess } from "bun";

interface ServiceSpec {
  name: string;
  command: string[];
  color: string;
  /** รอ service ก่อนหน้าให้พร้อมก่อนค่อยเริ่ม */
  delayMs?: number;
}

const RESET = "\x1b[0m";

const services: ServiceSpec[] = [
  {
    name: "api",
    command: ["bun", "--watch", "apps/control-api/src/index.ts"],
    color: "\x1b[36m",
  },
  {
    // worker รอ database ที่ API สร้างเองอยู่แล้ว (มี retry ภายใน)
    name: "worker",
    command: ["bun", "--watch", "apps/deploy-worker/src/index.ts"],
    color: "\x1b[35m",
    delayMs: 1000,
  },
  {
    name: "dashboard",
    command: ["bun", "run", "--filter", "@zixploy/dashboard", "dev"],
    color: "\x1b[32m",
    delayMs: 1500,
  },
];

const children: Subprocess[] = [];
let shuttingDown = false;

function prefixStream(stream: ReadableStream<Uint8Array>, name: string, color: string) {
  const label = `${color}[${name}]${RESET}`;
  const decoder = new TextDecoder();
  let buffer = "";

  (async () => {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) console.log(`${label} ${line}`);
      }
    }
    if (buffer.trim()) console.log(`${label} ${buffer}`);
  })();
}

function shutdown(signal: NodeJS.Signals | "exit") {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nหยุด development stack (${signal})…`);
  for (const child of children) {
    child.kill();
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

for (const service of services) {
  if (service.delayMs) await Bun.sleep(service.delayMs);
  if (shuttingDown) break;

  const child = Bun.spawn(service.command, {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
    onExit(_proc, exitCode) {
      if (shuttingDown) return;
      console.error(`\n${service.color}[${service.name}]${RESET} จบการทำงาน (exit ${exitCode})`);
      // service ใดตาย = หยุดทั้ง stack เพื่อไม่ให้เข้าใจผิดว่าระบบยังครบ
      shutdown("exit");
      process.exitCode = exitCode ?? 1;
    },
  });

  children.push(child);
  prefixStream(child.stdout as ReadableStream<Uint8Array>, service.name, service.color);
  prefixStream(child.stderr as ReadableStream<Uint8Array>, service.name, service.color);
}

console.log(`
${"\x1b[1m"}Zixploy development stack${RESET}
  Dashboard    http://localhost:3000
  Control API  http://127.0.0.1:3001
  Traefik      เปิดแยกด้วย: bun run dev:proxy

กด Ctrl+C เพื่อหยุดทั้งหมด
`);

await Promise.all(children.map((child) => child.exited));
