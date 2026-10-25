#!/usr/bin/env bash
# Установка systemd-юнитов резервного копирования SkyFraze.
#
#   sudo bash deploy/install-backup-units.sh [/путь/к/проекту]   # системные юниты
#   bash deploy/install-backup-units.sh --user                   # свои, без sudo
#
# Системный режим (по умолчанию) ставит четыре юнита:
#   skyfraze-backup.timer   — запускает копию раз в сутки (03:30 + случайный разброс)
#   skyfraze-backup.service — сам скрипт deploy/backup.sh
#   skyfraze-drill.timer    — раз в неделю запускает проверку восстановления
#   skyfraze-drill.service  — `deploy/backup.sh --drill` по свежей копии
#
# Про drill. Копия, которую ни разу не восстанавливали, копией не считается: файлы могут
# быть битыми, а дамп — нечитаемым, и узнать об этом лучше в воскресенье, чем в день аварии.
# Проверка разворачивает копию в ОТДЕЛЬНУЮ базу и временный каталог, рабочую не трогает, и
# убирает за собой. Провал виден как failed у юнита: `systemctl --user --failed`.
#
# Режим `--user` делает то же самое в пользовательском systemd: юниты кладутся в
# ~/.config/systemd/user и включаются `systemctl --user`. Он нужен там, где sudo просит
# пароль (или его вовсе нет), а копии делать надо: без расписания бэкапов фактически
# нет. Две вещи, без которых пользовательский таймер бесполезен, скрипт делает сам:
#
#   1. `loginctl enable-linger` — иначе таймер живёт только пока человек вошёл в систему,
#      и на сервере, куда заходят по ssh, копии не снимались бы почти никогда;
#   2. ожидание Docker в ExecStartPre — `Persistent=true` запускает пропущенную копию
#      сразу после загрузки, когда dockerd может быть ещё не готов.
#
# Запускать на хосте (не в контейнере) и один раз. Проверить после установки:
#   systemctl list-timers skyfraze-backup.timer            # + --user для режима --user
#   sudo systemctl start skyfraze-backup.service           # копия прямо сейчас (--user)
#   journalctl -u skyfraze-backup.service -n 50            # (+ --user)
#
# Отдельного пароля/ключа не требуется: юнит идёт от владельца каталога, а пользователь
# уже в группе docker (иначе он не запускал бы docker compose вручную).

set -euo pipefail

MODE="system"
case "${1:-}" in
  --user|-u) MODE="user"; shift || true ;;
  --system|-s) MODE="system"; shift || true ;;
esac

APP_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
INSTALL_USER="${SUDO_USER:-$(stat -c %U "$APP_DIR")}"

if [ "$MODE" = "system" ] && [ "$(id -u)" != "0" ]; then
  echo "Нужен root: sudo bash $0 $APP_DIR" >&2
  echo "Без sudo используйте: bash $0 --user" >&2
  exit 1
fi
if [ "$MODE" = "user" ] && [ "$(id -u)" = "0" ]; then
  echo "Режим --user запускается от себя, а не через sudo: bash $0 --user" >&2
  exit 1
fi

echo "== режим: $MODE"
echo "== каталог проекта: $APP_DIR"
echo "== пользователь сервиса: $INSTALL_USER"
[ -f "$APP_DIR/docker-compose.prod.yml" ] || { echo "нет docker-compose.prod.yml — проверьте путь" >&2; exit 1; }

# Каталог копий: создаём заранее и отдаём владельцу каталога, иначе первый запуск
# из-под сервиса упрётся в права.
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
mkdir -p "$BACKUP_DIR"
if [ "$MODE" = "system" ]; then
  chown -R "$INSTALL_USER" "$BACKUP_DIR"
fi
chmod +x "$APP_DIR/deploy/backup.sh"

install_system() {
  for unit in skyfraze-backup.service skyfraze-backup.timer skyfraze-drill.service skyfraze-drill.timer; do
    sed -e "s#/home/skyadmin/skyfraze#$APP_DIR#g" \
        -e "s#^User=skyadmin#User=$INSTALL_USER#" \
        -e "s#^Group=skyadmin#Group=$(id -gn "$INSTALL_USER")#" \
        "$APP_DIR/deploy/$unit" > "/etc/systemd/system/$unit"
    echo "   /etc/systemd/system/$unit"
  done

  systemctl daemon-reload
  systemctl enable --now skyfraze-backup.timer
  systemctl enable --now skyfraze-drill.timer

  echo "== таймеры:"
  systemctl list-timers 'skyfraze-*' --no-pager || true
  echo "== проверить копию прямо сейчас: sudo systemctl start skyfraze-backup.service"
  echo "== проверить восстановление сейчас: sudo systemctl start skyfraze-drill.service"
  echo "== что было: journalctl -u skyfraze-drill.service -n 50"
}

# В пользовательском режиме unit-файлы не копируются как есть, а собираются: `User=` и
# `Group=` в user-юнитах запрещены, `After=docker.service` не значит ничего (docker —
# системный юнит, у пользовательского менеджера своя очередь запуска).
install_user() {
  local dir="$HOME/.config/systemd/user"
  mkdir -p "$dir"

  cat > "$dir/skyfraze-backup.service" <<UNIT
[Unit]
Description=SkyFraze: резервная копия базы и вложений (пользовательский таймер)
Documentation=https://github.com/BarsSky/SkyFraze

[Service]
Type=oneshot
WorkingDirectory=$APP_DIR
Environment=SKYFRAZE_DIR=$APP_DIR
# Ждём docker: при Persistent=true пропущенная копия запускается сразу после загрузки,
# когда dockerd может быть ещё не готов.
ExecStartPre=/bin/sh -c 'for i in \$(seq 1 60); do docker info >/dev/null 2>&1 && exit 0; sleep 5; done; exit 1'
ExecStart=/bin/bash $APP_DIR/deploy/backup.sh
# Копия больших каталогов может занять время, но не минуты: ограничение нужно,
# чтобы зависший docker не держал юнит вечно.
TimeoutStartSec=1800
UNIT
  echo "   $dir/skyfraze-backup.service"

  sed -e "s#/home/skyadmin/skyfraze#$APP_DIR#g" \
      "$APP_DIR/deploy/skyfraze-backup.timer" > "$dir/skyfraze-backup.timer"
  echo "   $dir/skyfraze-backup.timer"

  # Проверка восстановления — тем же способом, что и копия: отдельный юнит и недельный
  # таймер. В user-режиме `User=`/`Group=` запрещены, поэтому сервис собирается здесь.
  cat > "$dir/skyfraze-drill.service" <<UNIT
[Unit]
Description=SkyFraze: проверка восстановления последней копии (пользовательский таймер)
Documentation=https://github.com/BarsSky/SkyFraze

[Service]
Type=oneshot
WorkingDirectory=$APP_DIR
Environment=SKYFRAZE_DIR=$APP_DIR
ExecStart=/bin/bash $APP_DIR/deploy/backup.sh --drill
TimeoutStartSec=1800
UNIT
  echo "   $dir/skyfraze-drill.service"

  sed -e "s#/home/skyadmin/skyfraze#$APP_DIR#g" \
      "$APP_DIR/deploy/skyfraze-drill.timer" > "$dir/skyfraze-drill.timer"
  echo "   $dir/skyfraze-drill.timer"

  # Без linger таймер останавливается с выходом последней сессии: на сервере это значит
  # «копий почти нет». Своему пользователю включать linger можно без root.
  if ! loginctl show-user "$INSTALL_USER" 2>/dev/null | grep -q '^Linger=yes'; then
    loginctl enable-linger "$INSTALL_USER" 2>/dev/null \
      || echo "   ! не удалось включить linger: таймер будет работать только при входе в систему" >&2
  fi

  systemctl --user daemon-reload
  systemctl --user enable --now skyfraze-backup.timer
  systemctl --user enable --now skyfraze-drill.timer

  echo "== таймеры:"
  systemctl --user list-timers 'skyfraze-*' --no-pager || true
  echo "== проверить копию прямо сейчас: systemctl --user start skyfraze-backup.service"
  echo "== проверить восстановление сейчас: systemctl --user start skyfraze-drill.service"
  echo "== журнал: journalctl --user -u skyfraze-backup.service -n 50"
}

if [ "$MODE" = "system" ]; then install_system; else install_user; fi
