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
# Сервис должен работать от владельца каталога: git не трогает репозиторий,
# владелец которого — другой пользователь, а под root это ровно так.
INSTALL_USER="${SUDO_USER:-$(stat -c %U "$APP_DIR")}"

if [ "$(id -u)" != "0" ]; then
  echo "Нужен root: sudo bash $0 $APP_DIR" >&2
  exit 1
fi

echo "== каталог проекта: $APP_DIR"
echo "== пользователь сервиса: $INSTALL_USER"
[ -f "$APP_DIR/docker-compose.prod.yml" ] || { echo "нет docker-compose.prod.yml — проверьте путь" >&2; exit 1; }
mkdir -p "$STATE_DIR"
chown -R "$INSTALL_USER" "$STATE_DIR"
chmod +x "$APP_DIR/deploy/skyfraze-update.sh"

echo "== подставляю пути в юниты"
for unit in skyfraze-update.service skyfraze-update.path; do
  sed -e "s#/home/skyadmin/skyfraze#$APP_DIR#g" \
      -e "s#^User=skyadmin#User=$INSTALL_USER#" \
      -e "s#^Group=skyadmin#Group=$(id -gn "$INSTALL_USER")#" \
      "$APP_DIR/deploy/$unit" > "/etc/systemd/system/$unit"
  echo "   /etc/systemd/system/$unit"
done

echo "== включаю и запускаю path-юнит"
systemctl daemon-reload
# Юнит мог остаться в состоянии failed от прошлых попыток: без сброса он красный
# и пугает раньше, чем что-то произойдёт.
systemctl reset-failed skyfraze-update.service 2>/dev/null || true
systemctl enable --now skyfraze-update.path

echo
echo "Готово. Проверка:"
systemctl status skyfraze-update.path --no-pager | head -5
echo
echo "Проверить вручную:  sudo $APP_DIR/deploy/skyfraze-update.sh"
echo "Посмотреть лог:     tail -f $STATE_DIR/update.log"
