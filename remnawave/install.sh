#!/usr/bin/env bash
# Remnawave Panel: установка на чистый Ubuntu/Debian одной командой.
# Запуск (от root):  bash install.sh panel.example.com you@example.com
#
# Что делает:
#   1. ставит Docker, если его нет
#   2. поднимает panel + postgres + valkey в /opt/remnawave
#   3. генерирует APP_SECRET, METRICS_PASS, WEBHOOK_SECRET_HEADER, пароль БД
#   4. ставит Caddy и выдаёт HTTPS-сертификат на ваш домен
#   5. печатает, что делать дальше (админ, API-токен, привязка к боту)

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"

if [[ -z "$DOMAIN" ]]; then
  echo "Использование: bash install.sh panel.example.com you@example.com"
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "Запускать от root: sudo bash install.sh $DOMAIN"
  exit 1
fi

echo "==> 0/6 память"
RAM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo)
if [[ "$RAM_MB" -lt 2000 ]]; then
  if [[ ! -f /swapfile ]]; then
    echo "    RAM ${RAM_MB} МБ — создаю swap 2 ГБ"
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    echo "    swap уже есть"
  fi
else
  echo "    RAM ${RAM_MB} МБ — хватает"
fi

echo "==> 1/6 Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
else
  echo "    уже установлен: $(docker --version)"
fi

echo "==> 2/6 файлы панели"
mkdir -p /opt/remnawave
cd /opt/remnawave

curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/remnawave/backend/refs/heads/main/docker-compose-prod.yml
if [[ ! -f .env ]]; then
  curl -fsSLo .env https://raw.githubusercontent.com/remnawave/backend/refs/heads/main/.env.sample
  echo "    .env скачан"
else
  echo "    .env уже есть — секреты не трогаю"
fi

echo "==> 3/6 секреты"
if grep -q '^APP_SECRET=$' .env || grep -q '^APP_SECRET="\?"\?$' .env; then
  sed -i "s|^APP_SECRET=.*|APP_SECRET=$(openssl rand -hex 64)|" .env
fi
sed -i "s|^METRICS_PASS=.*|METRICS_PASS=$(openssl rand -hex 64)|" .env
sed -i "s|^WEBHOOK_SECRET_HEADER=.*|WEBHOOK_SECRET_HEADER=$(openssl rand -hex 64)|" .env

if grep -q '^POSTGRES_PASSWORD=postgres' .env; then
  PW="$(openssl rand -hex 24)"
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$PW|" .env
  sed -i "s|^\(DATABASE_URL=\"\?postgresql://postgres:\)[^@]*\(@.*\)|\1$PW\2|" .env
  echo "    пароль БД сменён"
fi

echo "==> 4/6 домены"
sed -i "s|^FRONT_END_DOMAIN=.*|FRONT_END_DOMAIN=$DOMAIN|" .env
sed -i "s|^SUB_PUBLIC_DOMAIN=.*|SUB_PUBLIC_DOMAIN=$DOMAIN/api/sub/|" .env

echo "==> 5/6 контейнеры"
docker compose pull -q
docker compose up -d
sleep 5
docker compose ps

echo "==> 6/6 Caddy (HTTPS)"
if ! command -v caddy >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
fi

cat >/etc/caddy/Caddyfile <<EOF
$DOMAIN {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
EOF

systemctl restart caddy

echo
echo "=============================================================="
echo " Панель: https://$DOMAIN"
echo
echo " Дальше:"
echo "   1. Откройте панель и создайте первого администратора."
echo "   2. Settings → API Tokens → создайте токен (scopes: users, nodes, squads)."
echo "   3. Привяжите к боту на компьютере:"
echo "        cd vpn-hub-lite"
echo "        npx wrangler secret put REMNAWAVE_URL      # https://$DOMAIN"
echo "        npx wrangler secret put REMNAWAVE_TOKEN    # токен из п.2"
echo "        npx wrangler deploy"
echo "   4. В админке бота: /admin/squads — включите группы."
echo "=============================================================="
