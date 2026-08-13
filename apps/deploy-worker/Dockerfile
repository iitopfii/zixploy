# syntax=docker/dockerfile:1
# Build context: repo root (monorepo)
FROM oven/bun:1.3.5-alpine AS base
WORKDIR /repo

# ── 1. Install dependencies (cache layer) ─────────────────────────────────────
COPY package.json bun.lock ./
COPY internal/shared/package.json    ./internal/shared/
COPY internal/db/package.json        ./internal/db/
COPY apps/control-api/package.json   ./apps/control-api/
COPY apps/deploy-worker/package.json ./apps/deploy-worker/
COPY apps/dashboard/package.json     ./apps/dashboard/

RUN bun install --frozen-lockfile

# ── 2. Copy source ────────────────────────────────────────────────────────────
COPY internal/            ./internal/
COPY apps/deploy-worker/  ./apps/deploy-worker/
COPY migrations/          ./migrations/

# ── Runtime ───────────────────────────────────────────────────────────────────
# Worker needs docker CLI — install from Alpine apk
# util-linux: ให้คำสั่ง `script` ที่ใช้สร้าง PTY จริงสำหรับ web terminal (Phase 17) —
# docker exec -t ต้องการ TTY ที่ฝั่ง client, Bun.spawn ให้แค่ pipe จึงต้องมี script มาครอบ
# (ดู DockerCliClient.execInteractive)
RUN apk add --no-cache docker-cli docker-cli-buildx git util-linux

CMD ["bun", "run", "apps/deploy-worker/src/index.ts"]
