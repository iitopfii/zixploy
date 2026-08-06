#!/bin/bash
# Zixploy Server Setup Script
# รัน 1 ครั้งบน server ใหม่ (Ubuntu 24.04)
set -euo pipefail

SERVER_IP="${1:-$(hostname -I | awk '{print $1}')}"
echo "=== Zixploy Server Setup === IP: $SERVER_IP"

# ── 1. Install Docker ─────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "[1/5] Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  echo "      Docker installed: $(docker --version)"
else
  echo "[1/5] Docker already installed: $(docker --version)"
fi

# ── 2. Add swap (server มี 2.9GB RAM, ไม่มี swap) ────────────────────────────
if [ "$(swapon --show | wc -l)" -eq 0 ]; then
  echo "[2/5] Creating 2GB swap..."
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "      Swap enabled: $(free -h | grep Swap)"
else
  echo "[2/5] Swap already configured"
fi

# ── 3. Create master key ──────────────────────────────────────────────────────
echo "[3/5] Setting up master key..."
mkdir -p /etc/zixploy
if [ ! -f /etc/zixploy/master.key ]; then
  openssl rand -base64 32 > /etc/zixploy/master.key
  chmod 600 /etc/zixploy/master.key
  chown root:root /etc/zixploy/master.key
  echo "      Master key created at /etc/zixploy/master.key"
else
  echo "      Master key already exists"
fi

# ── 4. Create networks and volumes (idempotent) ───────────────────────────────
echo "[4/5] Creating Docker networks and volumes..."
docker network create zixploy-proxy    2>/dev/null || true
docker network create zixploy-internal 2>/dev/null || true
docker volume create zixploy-data      2>/dev/null || true
docker volume create zixploy-workspaces 2>/dev/null || true
docker volume create zixploy-backups   2>/dev/null || true

# ── 5. Build and start services ───────────────────────────────────────────────
echo "[5/5] Building images and starting services..."
cd /opt/zixploy
export SERVER_IP="$SERVER_IP"

docker compose -f deploy/server/docker-compose.yml build --no-cache 2>&1 | tail -20
docker compose -f deploy/server/docker-compose.yml up -d

echo ""
echo "=== Waiting for services to be healthy... ==="
sleep 15

# Check health
for svc in zixploy-traefik zixploy-control-api zixploy-dashboard; do
  status=$(docker inspect "$svc" --format '{{.State.Status}}' 2>/dev/null || echo "not found")
  echo "  $svc: $status"
done

echo ""
echo "=== Bootstrap admin account ==="
docker exec zixploy-control-api bun run apps/control-api/src/cli/bootstrap-admin.ts

echo ""
echo "=== Zixploy is ready! ==="
echo "  Dashboard: http://$SERVER_IP/"
echo "  API:       http://$SERVER_IP/api/v1/system/health"
echo ""
echo "  ⚠️  ควรทำหลัง deploy:"
echo "  1. เปลี่ยน root password: passwd"
echo "  2. ตั้งค่า SSH key auth และปิด password login"
echo "  3. ตั้ง firewall: ufw allow 22 && ufw allow 80 && ufw enable"
