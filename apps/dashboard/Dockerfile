# syntax=docker/dockerfile:1
# Build context: repo root (monorepo)

# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM oven/bun:1.3.5-alpine AS builder
WORKDIR /repo

# Copy ALL workspace manifests (bun workspace resolution requires all of them)
COPY package.json bun.lock ./
COPY internal/shared/package.json    ./internal/shared/
COPY internal/db/package.json        ./internal/db/
COPY apps/control-api/package.json   ./apps/control-api/
COPY apps/deploy-worker/package.json ./apps/deploy-worker/
COPY apps/dashboard/package.json     ./apps/dashboard/

RUN bun install --frozen-lockfile

# Copy source (dashboard needs control-api types for Eden treaty)
COPY internal/          ./internal/
COPY apps/control-api/  ./apps/control-api/
COPY apps/dashboard/    ./apps/dashboard/

# Build Nuxt SPA
RUN cd apps/dashboard && bun run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Copy only the built output
COPY --from=builder /repo/apps/dashboard/.output ./

EXPOSE 3000
ENV PORT=3000
ENV HOST=0.0.0.0
CMD ["node", "server/index.mjs"]
