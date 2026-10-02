#!/usr/bin/env bash
# Установка systemd-юнитов резервного копирования SkyFraze.
#
#   sudo bash deploy/install-backup-units.sh [/путь/к/проекту]
#
# Ставит два юнита:
#   skyfraze-backup.timer   — запускает копию раз в сутки (03:30 + случайный разброс)
#   skyfraze-backup.service — сам скрипт deploy/backup.sh
#
# Запускать на хосте (не в контейнере) и один раз. Проверить после установки:
#   systemctl list-timers skyfraze-backup.timer
#   sudo systemctl start skyfraze-backup.service   # копия прямо сейчас
#   journalctl -u skyfraze-backup.service -n 50

set -euo pipefail

APP_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
INSTALL_USER="${SUDO_USER:-$(stat -c %U "$APP_DIR")}"

if [ "$(id -u)" != "0" ]; then
  echo "Нужен root: sudo bash $0 $APP_DIR" >&2
  exit 1
fi

echo "== каталог проекта: $APP_DIR"
echo "== пользователь сервиса: $INSTALL_USER"
[ -f "$APP_DIR/docker-compose.prod.yml" ] || { echo "нет docker-compose.prod.yml — проверьте путь" >&2; exit 1; }

# Каталог копий: создаём заранее и отдаём владельцу каталога, иначе первый запуск
# из-под сервиса упрётся в права.
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
mkdir -p "$BACKUP_DIR"
chown -R "$INSTALL_USER" "$BACKUP_DIR"
chmod +x "$APP_DIR/deploy/backup.sh"

for unit in skyfraze-backup.service skyfraze-backup.timer; do
  sed -e "s#/home/skyadmin/skyfraze#$APP_DIR#g" \
      -e "s#^User=skyadmin#User=$INSTALL_USER#" \
      -e "s#^Group=skyadmin#Group=$(id -gn "$INSTALL_USER")#" \
      "$APP_DIR/deploy/$unit" > "/etc/systemd/system/$unit"
  echo "   /etc/systemd/system/$unit"
done

systemctl daemon-reload
systemctl enable --now skyfraze-backup.timer

echo "== таймер:"
systemctl list-timers skyfraze-backup.timer --no-pager || true
echo "== проверить копию прямо сейчас: sudo systemctl start skyfraze-backup.service"
echo "== проверить, что копия восстанавливается: bash $APP_DIR/deploy/backup.sh --drill"
