#!/bin/sh
# Zixploy installer — curl -sSL https://zixploy.com/install.sh | sh
#
# POSIX sh ไม่ใช่ bash: เครื่องเปล่าบางตัว (Alpine, container base image) ไม่มี bash
# ติดตั้งมาให้ ถ้าสคริปต์ต้องใช้ bash จะล้มตั้งแต่บรรทัดแรกโดยไม่มีข้อความบอกสาเหตุ
#
# ทำงานซ้ำได้ (idempotent): รันบนเครื่องที่ติดตั้งแล้วจะไม่สร้าง master key ใหม่
# ไม่เขียนทับ .env และไม่ลบข้อมูล — ใช้เป็นตัวซ่อมการติดตั้งที่ค้างกลางทางได้

set -eu

REPO_RAW="https://raw.githubusercontent.com/iitopfii/zixploy.com/main/deploy/install"
INSTALL_DIR="${ZIXPLOY_INSTALL_DIR:-/opt/zixploy}"
SECRET_DIR="/etc/zixploy"
MASTER_KEY="$SECRET_DIR/master.key"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
ENV_FILE="$INSTALL_DIR/.env"

# ── สี (ปิดเองเมื่อไม่ใช่ terminal เช่นตอน pipe เข้า log) ──
if [ -t 1 ]; then
  B=$(printf '\033[1m'); G=$(printf '\033[32m'); Y=$(printf '\033[33m')
  R=$(printf '\033[31m'); C=$(printf '\033[36m'); N=$(printf '\033[0m')
else
  B=''; G=''; Y=''; R=''; C=''; N=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '%s→%s %s\n' "$C" "$N" "$*"; }
ok()   { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*"; }
die()  { printf '%s✗ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

say ""
say "${B}Zixploy Installer${N}"
say ""

[ "$(id -u)" -eq 0 ] || die "ต้องรันด้วย root — ลองใหม่ด้วย: curl -sSL .../install.sh | sudo sh"
[ "$(uname -s)" = "Linux" ] || die "รองรับเฉพาะ Linux (พบ $(uname -s))"

ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64)  ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "ไม่รองรับสถาปัตยกรรม $ARCH — มีเฉพาะ amd64 และ arm64" ;;
esac
ok "ระบบ: Linux/$ARCH"

# port 80/443 ต้องว่าง — Traefik bind ทั้งคู่ ถ้าไม่ว่างจะ start ไม่ขึ้นแล้วหาสาเหตุยาก
check_port() {
  if command -v ss >/dev/null 2>&1; then
    ss -lntH "sport = :$1" 2>/dev/null | grep -q . && return 1
  elif command -v netstat >/dev/null 2>&1; then
    netstat -lnt 2>/dev/null | grep -q ":$1 " && return 1
  fi
  return 0
}
for PORT in 80 443; do
  # ถ้า Traefik ของเราถือ port อยู่ ถือว่าปกติ (กำลังติดตั้งซ้ำ)
  if ! check_port "$PORT"; then
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^zixploy-traefik$'; then
      : # ของเราเอง
    else
      die "port $PORT ถูกใช้อยู่โดยโปรแกรมอื่น — หยุดโปรแกรมนั้นก่อน (เช่น nginx, apache)"
    fi
  fi
done
ok "port 80 และ 443 ว่าง"

# ---------------------------------------------------------------------------
# Docker
# ---------------------------------------------------------------------------

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ok "Docker พร้อมใช้งาน ($(docker --version | cut -d' ' -f3 | tr -d ,))"
else
  step "ติดตั้ง Docker…"
  curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 || die "ติดตั้ง Docker ไม่สำเร็จ"
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker info >/dev/null 2>&1 || die "ติดตั้ง Docker แล้วแต่ daemon ไม่ทำงาน"
  ok "ติดตั้ง Docker เรียบร้อย"
fi

docker compose version >/dev/null 2>&1 || die "ไม่พบ docker compose plugin — อัปเดต Docker เป็นรุ่นใหม่กว่านี้"

# ---------------------------------------------------------------------------
# Master key — ความลับที่สำคัญที่สุดของระบบ
# ---------------------------------------------------------------------------
#
# ใช้เข้ารหัส GitHub App PEM, environment variables, TLS key และรหัสผ่าน database
# ทั้งหมด **หายแล้วกู้ข้อมูลเหล่านั้นไม่ได้เลย** จึงไม่สร้างทับของเดิมเด็ดขาด

mkdir -p "$SECRET_DIR"
chmod 700 "$SECRET_DIR"

if [ -f "$MASTER_KEY" ]; then
  ok "ใช้ master key เดิมที่มีอยู่แล้ว"
else
  step "สร้าง master key…"
  # 32 byte จาก /dev/urandom → base64 (รูปแบบที่ loadMasterKeys() อ่าน)
  head -c 32 /dev/urandom | base64 -w0 2>/dev/null > "$MASTER_KEY" \
    || head -c 32 /dev/urandom | base64 | tr -d '\n' > "$MASTER_KEY"
  chmod 600 "$MASTER_KEY"
  ok "สร้าง master key แล้ว ($MASTER_KEY)"
  warn "สำรองไฟล์นี้ไว้ — หายแล้วข้อมูลที่เข้ารหัสไว้กู้คืนไม่ได้"
fi

# ---------------------------------------------------------------------------
# ไฟล์ติดตั้ง
# ---------------------------------------------------------------------------

mkdir -p "$INSTALL_DIR"

step "ดาวน์โหลด compose file…"
curl -fsSL "$REPO_RAW/docker-compose.yml" -o "$COMPOSE_FILE" \
  || die "ดาวน์โหลด docker-compose.yml ไม่สำเร็จ"
ok "compose file พร้อม"

# หา public IP — ใช้ตั้ง ZIXPLOY_PUBLIC_IPS (DNS check เทียบกับค่านี้) และ base URL
detect_ip() {
  for URL in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    IP=$(curl -fsSL --max-time 5 "$URL" 2>/dev/null | tr -d '[:space:]')
    case "$IP" in
      *[!0-9.]*|"") continue ;;
      *) printf '%s' "$IP"; return 0 ;;
    esac
  done
  return 1
}

if [ -f "$ENV_FILE" ]; then
  ok "ใช้ .env เดิม (ไม่เขียนทับค่าที่ตั้งไว้)"
  # เวอร์ชันเป็นค่าเดียวที่ต้องอัปเดตเสมอ — ตัวอัปเดตในระบบก็เขียนบรรทัดนี้เหมือนกัน
  VERSION="${ZIXPLOY_VERSION:-$(grep -E '^ZIXPLOY_VERSION=' "$ENV_FILE" | cut -d= -f2- || echo latest)}"
else
  step "ตรวจหา public IP…"
  SERVER_IP=$(detect_ip) || die "หา public IP ไม่ได้ — ตั้งเองด้วย ZIXPLOY_SERVER_IP=x.x.x.x"
  SERVER_IP="${ZIXPLOY_SERVER_IP:-$SERVER_IP}"
  ok "public IP: $SERVER_IP"

  VERSION="${ZIXPLOY_VERSION:-latest}"

  cat > "$ENV_FILE" <<EOF
# สร้างโดย install.sh — แก้ได้ แล้วรัน: cd $INSTALL_DIR && docker compose up -d
ZIXPLOY_VERSION=$VERSION
SERVER_IP=$SERVER_IP
ZIXPLOY_BASE_URL=http://$SERVER_IP
ZIXPLOY_INSTALL_DIR=$INSTALL_DIR
# อีเมลสำหรับ Let's Encrypt แจ้งเตือนก่อน cert หมดอายุ
# ปล่อยว่างได้ แต่ห้ามใส่ค่าที่ไม่ใช่อีเมลจริง — LE ปฏิเสธทั้ง account
# ถ้า domain ของอีเมลไม่มีจุด แล้วขอ cert ไม่ได้ทั้งเซิร์ฟเวอร์
ACME_EMAIL=${ZIXPLOY_ACME_EMAIL:-}
EOF
  chmod 600 "$ENV_FILE"
  ok "สร้าง .env แล้ว"
fi

# ---------------------------------------------------------------------------
# เริ่มระบบ
# ---------------------------------------------------------------------------

cd "$INSTALL_DIR"

step "ดึง image (ครั้งแรกอาจใช้เวลาสักครู่)…"
docker compose pull --quiet || die "ดึง image ไม่สำเร็จ — ตรวจการเชื่อมต่อเน็ตและว่า package เป็นสาธารณะแล้ว"

step "เริ่มระบบ…"
docker compose up -d --remove-orphans >/dev/null || die "เริ่มระบบไม่สำเร็จ — ดูรายละเอียดด้วย: cd $INSTALL_DIR && docker compose logs"

step "รอให้ระบบพร้อม…"
READY=0
i=0
while [ $i -lt 60 ]; do
  if curl -fsS --max-time 3 "http://127.0.0.1/api/v1/system/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  i=$((i + 1))
  sleep 2
done

[ "$READY" -eq 1 ] || die "ระบบไม่ตอบสนองใน 2 นาที — ดู log ด้วย: cd $INSTALL_DIR && docker compose logs"

# ---------------------------------------------------------------------------
# สร้างผู้ดูแลระบบคนแรก
# ---------------------------------------------------------------------------

BASE_URL=$(grep -E '^ZIXPLOY_BASE_URL=' "$ENV_FILE" | cut -d= -f2-)

if docker compose exec -T control-api bun run apps/control-api/src/cli/bootstrap-admin.ts --check >/dev/null 2>&1; then
  ADMIN_EXISTS=1
else
  ADMIN_EXISTS=0
fi

say ""
say "${G}${B}ติดตั้งเรียบร้อย${N}"
say ""
say "  เปิดใช้งานที่:  ${B}${BASE_URL}${N}"
say "  ไฟล์ติดตั้ง:    $INSTALL_DIR"
say "  master key:     $MASTER_KEY  ${Y}(สำรองไว้ด้วย)${N}"
say ""

if [ "$ADMIN_EXISTS" -eq 0 ]; then
  say "  ${B}สร้างบัญชีผู้ดูแลระบบ:${N}"
  say "    cd $INSTALL_DIR && docker compose exec control-api \\"
  say "      bun run apps/control-api/src/cli/bootstrap-admin.ts"
  say ""
fi

say "  คำสั่งที่ใช้บ่อย:"
say "    cd $INSTALL_DIR && docker compose logs -f     # ดู log"
say "    cd $INSTALL_DIR && docker compose restart     # รีสตาร์ท"
say ""
