#!/bin/sh
# Zixploy installer — curl -sSL https://zixploy.com/install.sh | sh
#
# POSIX sh ไม่ใช่ bash: เครื่องเปล่าบางตัว (Alpine, container base image) ไม่มี bash
# ติดตั้งมาให้ ถ้าสคริปต์ต้องใช้ bash จะล้มตั้งแต่บรรทัดแรกโดยไม่มีข้อความบอกสาเหตุ
#
# ทำงานซ้ำได้ (idempotent): รันบนเครื่องที่ติดตั้งแล้วจะไม่สร้าง master key ใหม่
# ไม่เขียนทับ .env และไม่ลบข้อมูล — ใช้เป็นตัวซ่อมการติดตั้งที่ค้างกลางทางได้

set -eu

REPO_RAW="https://raw.githubusercontent.com/iitopfii/zixploy/main/deploy/install"
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

# หาเลข semver ล่าสุดจาก GHCR โดยตรง — endpoint และตรรกะเดียวกับที่ control-api ใช้ตรวจ
# update เอง (internal/shared/src/version.ts, UPDATE_CHECK) เพื่อไม่ให้สองที่ตัดสิน
# "เวอร์ชันล่าสุดคืออะไร" ไม่ตรงกัน — package บน GHCR เป็นสาธารณะ อ่าน tag ได้โดยไม่ต้อง
# login แต่ registry ยังบังคับให้มี bearer token เสมอ จึงขอ token แบบ anonymous ก่อน
#
# กรอง tag ที่ไม่ใช่ semver ("latest", "main", sha) และ pre-release ออก แล้วเลือกตัวมากสุด
# ด้วย sort -V (version sort) — พิมพ์ผลลัพธ์ออก stdout, ไม่มีอะไรพิมพ์ = หาไม่ได้
resolve_latest_version() {
  TOKEN=$(curl -fsSL --max-time 8 \
    "https://ghcr.io/token?scope=repository%3Aiitopfii%2Fzixploy-control-api%3Apull&service=ghcr.io" \
    2>/dev/null | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  [ -n "$TOKEN" ] || return 1

  TAGS_JSON=$(curl -fsSL --max-time 8 \
    -H "Authorization: Bearer $TOKEN" \
    "https://ghcr.io/v2/iitopfii/zixploy-control-api/tags/list" 2>/dev/null)
  [ -n "$TAGS_JSON" ] || return 1

  printf '%s' "$TAGS_JSON" \
    | tr ',' '\n' \
    | sed -n 's/.*"\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' \
    | sort -V \
    | tail -n1
}

# HTTP/HTTPS port ที่จะเปิดรับบนเครื่องนี้ — ค่าเริ่มต้น 80/443 เหมือน Traefik ทั่วไป
# เปลี่ยนได้ด้วย ZIXPLOY_HTTP_PORT/ZIXPLOY_HTTPS_PORT=xxxx ก่อนรันสคริปต์ (ตั้งครั้งแรกเท่านั้น
# เหมือน ZIXPLOY_VERSION — ติดตั้งซ้ำจะอ่านค่าที่ตั้งไว้ใน .env เดิม ไม่ถามซ้ำ)
HTTP_PORT="${ZIXPLOY_HTTP_PORT:-}"
HTTPS_PORT="${ZIXPLOY_HTTPS_PORT:-}"
if [ -f "$ENV_FILE" ]; then
  [ -n "$HTTP_PORT" ] || HTTP_PORT=$(grep -E '^ZIXPLOY_HTTP_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
  [ -n "$HTTPS_PORT" ] || HTTPS_PORT=$(grep -E '^ZIXPLOY_HTTPS_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
fi
HTTP_PORT="${HTTP_PORT:-80}"
HTTPS_PORT="${HTTPS_PORT:-443}"

# port ที่เลือกต้องว่าง — Traefik bind ทั้งคู่ ถ้าไม่ว่างจะ start ไม่ขึ้นแล้วหาสาเหตุยาก
check_port() {
  if command -v ss >/dev/null 2>&1; then
    ss -lntH "sport = :$1" 2>/dev/null | grep -q . && return 1
  elif command -v netstat >/dev/null 2>&1; then
    netstat -lnt 2>/dev/null | grep -q ":$1 " && return 1
  fi
  return 0
}
for PORT in "$HTTP_PORT" "$HTTPS_PORT"; do
  # ถ้า Traefik ของเราถือ port อยู่ ถือว่าปกติ (กำลังติดตั้งซ้ำ)
  if ! check_port "$PORT"; then
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^zixploy-traefik$'; then
      : # ของเราเอง
    else
      die "port $PORT ถูกใช้อยู่โดยโปรแกรมอื่น — หยุดโปรแกรมนั้นก่อน (เช่น nginx, apache)"
    fi
  fi
done
ok "port $HTTP_PORT และ $HTTPS_PORT ว่าง"

if [ "$HTTP_PORT" != "80" ]; then
  warn "HTTP port เป็น $HTTP_PORT (ไม่ใช่ 80) — Let's Encrypt อัตโนมัติใช้ไม่ได้ เพราะ HTTP-01"
  warn "challenge ต้องมี port 80 จริงจากอินเทอร์เน็ต ต้องอัปโหลด TLS certificate เองแทน"
  warn "(dashboard → Domains → Custom TLS หลังติดตั้งเสร็จ)"
fi

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

  # ค่าเริ่มต้นต้องเป็นเลขเวอร์ชันจริง (เช่น "0.1.0") ไม่ใช่คำว่า "latest"
  #
  # image tag "latest" ใช้ pull ได้ปกติ แต่ระบบใช้ ZIXPLOY_VERSION ตัวเดียวกันนี้เป็น
  # "เวอร์ชันของตัวเอง" ด้วย (ดู internal/shared/src/version.ts) เพื่อเทียบกับ release ใหม่
  # บน registry — คำว่า "latest" ไม่ใช่ semver เทียบไม่ได้เลย ปุ่ม Update จะไม่ขึ้นตลอดไป
  # แม้จะมี release ใหม่ออกกี่ครั้งก็ตาม จึงต้อง resolve เป็นเลขจริงตั้งแต่ตอนติดตั้ง
  if [ -n "${ZIXPLOY_VERSION:-}" ]; then
    VERSION="$ZIXPLOY_VERSION"
  else
    step "หาเวอร์ชันล่าสุด…"
    VERSION=$(resolve_latest_version) || VERSION=""
    if [ -n "$VERSION" ]; then
      ok "เวอร์ชันล่าสุด: $VERSION"
    else
      VERSION="latest"
      warn "หาเลขเวอร์ชันจาก registry ไม่ได้ — ใช้ tag latest แทน (ปุ่มอัปเดตในระบบจะใช้ไม่ได้จนกว่าจะตั้ง ZIXPLOY_VERSION เป็นเลขจริงเอง)"
    fi
  fi

  # BASE_URL ต้องตรงกับ host ที่ browser ใช้เข้าจริงเป๊ะ — origin-guard (plugins/origin-guard.ts)
  # ปฏิเสธ request ที่ Host header ไม่ตรงกับค่านี้ (INVALID_HOST) และ GitHub App manifest/webhook
  # URL ก็ generate จากค่านี้เหมือนกัน ถ้าเข้าผ่าน domain (เช่นอยู่หลัง Cloudflare) ต้องตั้ง
  # ZIXPLOY_DOMAIN ไม่งั้นค่า default จะเป็น IP ตรง ๆ ซึ่ง login ผ่าน domain จะโดน INVALID_HOST
  if [ -n "${ZIXPLOY_DOMAIN:-}" ]; then
    if [ "$HTTPS_PORT" = "443" ]; then
      BASE_URL_VALUE="https://$ZIXPLOY_DOMAIN"
    else
      BASE_URL_VALUE="https://$ZIXPLOY_DOMAIN:$HTTPS_PORT"
    fi
    ok "ใช้ domain: $ZIXPLOY_DOMAIN"
  elif [ "$HTTP_PORT" = "80" ]; then
    # ไม่มี port ต่อท้ายด้วยถ้าไม่ใช่ 80 — ไม่งั้น webhook/callback URL ที่ระบบ generate ให้
    # (เช่น GitHub App manifest) จะชี้ไปที่ port 80 ที่ไม่มีอะไรฟังอยู่จริง
    BASE_URL_VALUE="http://$SERVER_IP"
  else
    BASE_URL_VALUE="http://$SERVER_IP:$HTTP_PORT"
  fi

  cat > "$ENV_FILE" <<EOF
# สร้างโดย install.sh — แก้ได้ แล้วรัน: cd $INSTALL_DIR && docker compose up -d
ZIXPLOY_VERSION=$VERSION
SERVER_IP=$SERVER_IP
# host ที่ browser ต้องเข้าให้ตรงเป๊ะ — เปลี่ยนทีหลังต้องแก้ทั้งบรรทัดนี้ด้วย ไม่ใช่แค่ DNS
# (origin-guard เทียบ Host header กับค่านี้ตรง ๆ)
ZIXPLOY_BASE_URL=$BASE_URL_VALUE
ZIXPLOY_INSTALL_DIR=$INSTALL_DIR
# port ฝั่ง host ที่ Traefik รับทราฟฟิก — เปลี่ยนจาก 80/443 ได้ แต่ HTTP_PORT != 80 แปลว่า
# Let's Encrypt อัตโนมัติใช้ไม่ได้ (ต้องอัปโหลด TLS certificate เองแทน — ดูใน dashboard)
ZIXPLOY_HTTP_PORT=$HTTP_PORT
ZIXPLOY_HTTPS_PORT=$HTTPS_PORT
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
  if curl -fsS --max-time 3 "http://127.0.0.1:$HTTP_PORT/api/v1/system/health" >/dev/null 2>&1; then
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

# มี user อยู่แล้วหรือยัง — ถามจาก DB ตรง ๆ
# (bootstrap-admin.ts ไม่มีโหมด --check และจะ exit 1 ถ้าไม่ส่ง env มาให้)
ADMIN_COUNT=$(docker compose exec -T control-api sh -c \
  'bun -e "const{Database}=require(\"bun:sqlite\");const db=new Database(\"/data/control.db\");console.log(db.query(\"SELECT COUNT(*) c FROM users\").get().c)"' \
  2>/dev/null | tr -dc '0-9')
[ -n "$ADMIN_COUNT" ] || ADMIN_COUNT=0

NEW_ADMIN=0
if [ "$ADMIN_COUNT" -eq 0 ]; then
  step "สร้างบัญชีผู้ดูแลระบบ…"
  # สุ่มรหัสผ่านให้ เพราะ curl | sh รับ input จากผู้ใช้ไม่ได้ (stdin เป็นตัวสคริปต์เอง)
  # ส่งผ่าน env ของ exec ไม่ใช่ argument — argument จะโผล่ใน `ps` ของทั้งเครื่อง
  ADMIN_PASS=$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-20)
  if docker compose exec -T \
      -e ZIXPLOY_ADMIN_USERNAME=admin \
      -e ZIXPLOY_ADMIN_PASSWORD="$ADMIN_PASS" \
      control-api bun run apps/control-api/src/cli/bootstrap-admin.ts >/dev/null 2>&1; then
    NEW_ADMIN=1
    ok "สร้างบัญชี admin แล้ว"
  else
    warn "สร้างบัญชี admin อัตโนมัติไม่สำเร็จ — สร้างเองภายหลังได้ (ดูคำสั่งด้านล่าง)"
  fi
fi

say ""
say "${G}${B}ติดตั้งเรียบร้อย${N}"
say ""
say "  เปิดใช้งานที่:  ${B}${BASE_URL}${N}"
say "  ไฟล์ติดตั้ง:    $INSTALL_DIR"
say "  master key:     $MASTER_KEY  ${Y}(สำรองไว้ด้วย)${N}"
say ""

if [ "$NEW_ADMIN" -eq 1 ]; then
  say "  ${B}บัญชีผู้ดูแลระบบ${N}"
  say "    username:  ${B}admin${N}"
  say "    password:  ${B}${ADMIN_PASS}${N}"
  say "    ${Y}จดไว้ตอนนี้ — จะไม่แสดงอีก และควรเปลี่ยนหลัง login ครั้งแรก${N}"
  say ""
elif [ "$ADMIN_COUNT" -eq 0 ]; then
  say "  ${B}สร้างบัญชีผู้ดูแลระบบเอง:${N}"
  say "    cd $INSTALL_DIR && docker compose exec \\"
  say "      -e ZIXPLOY_ADMIN_USERNAME=admin -e ZIXPLOY_ADMIN_PASSWORD='รหัสผ่านที่ต้องการ' \\"
  say "      control-api bun run apps/control-api/src/cli/bootstrap-admin.ts"
  say ""
fi

say "  คำสั่งที่ใช้บ่อย:"
say "    cd $INSTALL_DIR && docker compose logs -f     # ดู log"
say "    cd $INSTALL_DIR && docker compose restart     # รีสตาร์ท"
say "    cd $INSTALL_DIR && docker compose pull && docker compose up -d   # อัปเดตเอง"
say ""
