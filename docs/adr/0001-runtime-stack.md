# ADR-0001: Runtime Stack — Bun + Elysia + Nuxt + SQLite + Traefik

สถานะ: Accepted (Phase 0)

## บริบท

ระบบเป็น single-node, single-admin deployment platform ต้องการ stack ที่เบา ดูแลโดยคนเดียว และ TypeScript ทั้งระบบ

## ตัดสินใจ

- **Bun** เป็น runtime, package manager และ test runner ของ backend ทั้งหมด
- **Elysia** เป็น HTTP framework ของ Control API (typed schema, SSE support)
- **Nuxt** เป็น Dashboard (UI + auth pages) — ไม่ทำงานหนักฝั่ง server
- **SQLite (WAL)** เป็นฐานข้อมูลเดียว รวมถึงเป็น durable queue (ดู ADR-0003)
- **Traefik** เป็น reverse proxy — configuration ผ่าน Docker labels

## ทางเลือกที่ปัดตก

- Node + Fastify/Hono: ได้ แต่ Bun ลด toolchain (runtime+PM+test ในตัวเดียว)
- Postgres: เกินจำเป็นสำหรับ single node, เพิ่ม service ที่ต้องดูแล
- Nginx + certbot: ต้อง reload/orchestrate เอง; Traefik อ่าน labels อัตโนมัติและมี ACME ในตัว

## ผลที่ตามมา

- Pin Bun version ใน lockfile และ release image — Bun ยังอัปเดตเร็ว ต้อง integration test ก่อน bump
- ทุก integration ที่แตะ Docker/Traefik ทดสอบบน Linux เป็นหลัก
