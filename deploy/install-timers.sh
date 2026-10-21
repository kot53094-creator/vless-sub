#!/usr/bin/env bash
# Устанавливает systemd-таймеры VPN Hub.
# Запуск: sudo ./deploy/install-timers.sh [/opt/vless-sub]
set -euo pipefail

APP_DIR="${1:-/opt/vless-sub}"
UNIT_DIR="/etc/systemd/system"

if [[ $EUID -ne 0 ]]; then
  echo "Нужен root: sudo $0 $APP_DIR" >&2
  exit 1
fi
if [[ ! -f "$APP_DIR/docker-compose.yml" ]]; then
  echo "Не нахожу $APP_DIR/docker-compose.yml — укажите путь к проекту" >&2
  exit 1
fi

for unit in vpnhub-sync.service vpnhub-detector.service; do
  sed "s#/opt/vless-sub#$APP_DIR#g" "$APP_DIR/deploy/$unit" > "$UNIT_DIR/$unit"
done
cp "$APP_DIR/deploy/vpnhub-sync.timer" "$APP_DIR/deploy/vpnhub-detector.timer" "$UNIT_DIR/"

systemctl daemon-reload

# Встроенный планировщик должен быть выключен, иначе прогоны дублируются.
if grep -q '^HUB_SCHEDULER_ENABLED=0' "$APP_DIR/.env" 2>/dev/null; then
  echo "HUB_SCHEDULER_ENABLED=0 — ок"
else
  echo "ВНИМАНИЕ: добавьте HUB_SCHEDULER_ENABLED=0 в $APP_DIR/.env и перезапустите хаб,"
  echo "          иначе синхронизация будет идти и внутри приложения, и по таймеру."
fi

systemctl enable --now vpnhub-sync.timer vpnhub-detector.timer
systemctl list-timers 'vpnhub-*' --no-pager || true
echo
echo "Проверить вручную: systemctl start vpnhub-sync.service && journalctl -u vpnhub-sync -n 50"
