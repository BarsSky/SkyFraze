#!/usr/bin/env bash
# Установка systemd-юнитов механизма обновления SkyFraze.
#
#   sudo bash deploy/install-update-units.sh [/путь/к/проекту]
#
# Ставит два юнита:
#   skyfraze-update.path    — смотрит за update-state/request.json (заявка из админки)
#   skyfraze-update.service — запускает deploy/skyfraze-update.sh
#
# Запускать нужно на хосте (не в контейнере) и один раз.

set -euo pipefail

APP_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATE_DIR="$APP_DIR/update-state"

if [ "$(id -u)" != "0" ]; then
  echo "Нужен root: sudo bash $0 $APP_DIR" >&2
  exit 1
fi

echo "== каталог проекта: $APP_DIR"
[ -f "$APP_DIR/docker-compose.prod.yml" ] || { echo "нет docker-compose.prod.yml — проверьте путь" >&2; exit 1; }
mkdir -p "$STATE_DIR"
chmod +x "$APP_DIR/deploy/skyfraze-update.sh"

echo "== подставляю пути в юниты"
for unit in skyfraze-update.service skyfraze-update.path; do
  sed -e "s#/home/skyadmin/skyfraze#$APP_DIR#g" \
      "$APP_DIR/deploy/$unit" > "/etc/systemd/system/$unit"
  echo "   /etc/systemd/system/$unit"
done

echo "== включаю и запускаю path-юнит"
systemctl daemon-reload
systemctl enable --now skyfraze-update.path

echo
echo "Готово. Проверка:"
systemctl status skyfraze-update.path --no-pager | head -5
echo
echo "Проверить вручную:  sudo $APP_DIR/deploy/skyfraze-update.sh"
echo "Посмотреть лог:     tail -f $STATE_DIR/update.log"
