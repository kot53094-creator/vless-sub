#!/usr/bin/env bash
# install-node.sh — поднимает на чистом Ubuntu 22.04/24.04 ноду:
#   * Xray: VLESS + Reality (TCP, порт NODE_PORT, по умолчанию 443)
#   * Hysteria2 (UDP, порт HY2_PORT, по умолчанию 8443) с самоподписанным TLS
#   * ufw: только SSH, Reality и Hysteria2; BBR включён
# В конце печатает две ссылки маркерами VLESS_LINK= и HY2_LINK= — их читает хаб.
#
# Запуск:  sudo NODE_NAME=de-1 ./install-node.sh
# Переменные: NODE_PORT (443), HY2_PORT (8443), SNI (www.microsoft.com),
#             NODE_NAME (имя ноды), XRAY_VERSION (по умолчанию latest)

set -euo pipefail

NODE_PORT="${NODE_PORT:-443}"
HY2_PORT="${HY2_PORT:-8443}"
SNI="${SNI:-www.microsoft.com}"
NODE_NAME="${NODE_NAME:-$(hostname -s 2>/dev/null || echo node)}"
XRAY_VERSION="${XRAY_VERSION:-latest}"

log() { printf '\033[1;33m[node]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "запускать от root (sudo)"
command -v apt-get >/dev/null || die "нужен Ubuntu/Debian с apt"
. /etc/os-release 2>/dev/null || true
case "${ID:-}${VERSION_ID:-}" in
  ubuntu22*|ubuntu24*|debian12*) : ;;
  *) log "предупреждение: проверено на Ubuntu 22/24 и Debian 12, у вас ${PRETTY_NAME:-неизвестно}" ;;
esac

export DEBIAN_FRONTEND=noninteractive
log "пакеты"
apt-get update -qq
apt-get install -y -qq curl ca-certificates openssl jq uuid-runtime ufw >/dev/null

# ─── генерация ключей ──────────────────────────────────────────────────────
UUID="$(uuidgen)"
SHORT_ID="$(openssl rand -hex 8)"
HY2_PASS="$(openssl rand -base64 24 | tr -d '\n=+/' | cut -c1-24)"
log "UUID ${UUID:0:8}…, shortId ${SHORT_ID}"

log "ставлю Xray"
bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install >/dev/null

# x25519: ключи Reality генерирует сам Xray
KEYS="$(/usr/local/bin/xray x25519)"
PRIVATE_KEY="$(printf '%s\n' "$KEYS" | awk -F': *' '/Private/{print $2; exit}')"
PUBLIC_KEY="$(printf '%s\n' "$KEYS" | awk -F': *' '/Public/{print $2; exit}')"
[[ -n "$PRIVATE_KEY" && -n "$PUBLIC_KEY" ]] || die "не удалось сгенерировать ключи Reality"

log "конфиг Xray (Reality на ${NODE_PORT}/tcp, SNI ${SNI})"
cat >/usr/local/etc/xray/config.json <<JSON
{
  "log": { "loglevel": "warning" },
  "inbounds": [
    {
      "listen": "0.0.0.0",
      "port": ${NODE_PORT},
      "protocol": "vless",
      "tag": "reality-in",
      "settings": {
        "clients": [ { "id": "${UUID}", "flow": "xtls-rprx-vision" } ],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "show": false,
          "dest": "${SNI}:443",
          "xver": 0,
          "serverNames": [ "${SNI}" ],
          "privateKey": "${PRIVATE_KEY}",
          "shortIds": [ "${SHORT_ID}" ]
        }
      },
      "sniffing": { "enabled": true, "destOverride": [ "http", "tls", "quic" ] }
    }
  ],
  "outbounds": [
    { "protocol": "freedom", "tag": "direct" },
    { "protocol": "blackhole", "tag": "block" }
  ],
  "routing": {
    "rules": [
      { "type": "field", "ip": [ "geoip:private" ], "outboundTag": "block" }
    ]
  }
}
JSON
systemctl enable xray >/dev/null 2>&1 || true
systemctl restart xray

# ─── Hysteria2 ─────────────────────────────────────────────────────────────
log "ставлю Hysteria2 (UDP ${HY2_PORT})"
if ! command -v hysteria >/dev/null; then
  bash -c "$(curl -fsSL https://get.hy2.sh/)" >/dev/null
fi

mkdir -p /etc/hysteria
openssl ecparam -genkey -name prime256v1 -out /etc/hysteria/key.pem >/dev/null 2>&1
openssl req -x509 -new -key /etc/hysteria/key.pem -out /etc/hysteria/cert.pem \
  -days 3650 -subj "/CN=${SNI}" >/dev/null 2>&1

cat >/etc/hysteria/config.yaml <<YAML
listen: :${HY2_PORT}
tls:
  cert: /etc/hysteria/cert.pem
  key: /etc/hysteria/key.pem
auth:
  type: password
  password: ${HY2_PASS}
masquerade:
  type: proxy
  proxy:
    url: https://news.ycombinator.com/
    rewriteHost: true
YAML

cat >/etc/systemd/system/hysteria-server.service <<UNIT
[Unit]
Description=Hysteria2 Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/hysteria server -c /etc/hysteria/config.yaml
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable hysteria-server >/dev/null 2>&1 || true
systemctl restart hysteria-server

# ─── сеть ──────────────────────────────────────────────────────────────────
log "BBR и firewall"
cat >/etc/sysctl.d/99-bbr.conf <<SYS
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
net.ipv4.tcp_fastopen=3
net.core.rmem_max=16777216
net.core.wmem_max=16777216
SYS
sysctl --system >/dev/null 2>&1 || true

SSH_PORT="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')"
SSH_PORT="${SSH_PORT:-22}"
ufw --force reset >/dev/null 2>&1 || true
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow "${SSH_PORT}/tcp" >/dev/null
ufw allow "${NODE_PORT}/tcp" >/dev/null
ufw allow "${HY2_PORT}/udp" >/dev/null
ufw --force enable >/dev/null
log "ufw: ${SSH_PORT}/tcp, ${NODE_PORT}/tcp, ${HY2_PORT}/udp"

# ─── ссылки ────────────────────────────────────────────────────────────────
IP="$(curl -fsS4 --max-time 10 https://api.ipify.org || true)"
[[ -n "$IP" ]] || IP="$(hostname -I | awk '{print $1}')"

VLESS_LINK="vless://${UUID}@${IP}:${NODE_PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=${SNI}&fp=chrome&pbk=${PUBLIC_KEY}&sid=${SHORT_ID}&type=tcp#${NODE_NAME}-reality"
HY2_LINK="hysteria2://${HY2_PASS}@${IP}:${HY2_PORT}?sni=${SNI}&insecure=1#${NODE_NAME}-hy2"

sleep 2
ok_xray="$(systemctl is-active xray || true)"
ok_hy2="$(systemctl is-active hysteria-server || true)"
log "xray: ${ok_xray}, hysteria: ${ok_hy2}"

cat <<OUT

──────────────────────────────────────────────
Готово. Ссылки для клиента:

VLESS_LINK=${VLESS_LINK}
HY2_LINK=${HY2_LINK}
NODE_IP=${IP}
──────────────────────────────────────────────
OUT
