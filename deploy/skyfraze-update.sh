#!/usr/bin/env bash
# Применение обновления SkyFraze на хосте.
#
# Запускается либо systemd (path-юнит замечает заявку из админки), либо вручную:
#
#   ./skyfraze-update.sh                 # обновиться до последнего тега
#   ./skyfraze-update.sh v0.2.1          # обновиться до конкретного тега
#
# Почему обновление живёт на хосте, а не в контейнере: приложение работает в Docker,
# а исходники и docker-compose — на хосте. Контейнеру для самопересборки понадобился
# бы docker.sock, то есть root на хосте. Здесь же веб-процесс только оставляет заявку.
#
# Что делает скрипт:
#   1. git fetch + переключение на нужный тег/ветку (каталог .env не трогается);
#   2. docker compose build + up -d;
#   3. health-check API; если не поднялось — сообщение об ошибке в статусе;
#   4. пишет status.json и update.log в каталог состояния, который читает админка.

set -euo pipefail

# ── настройки (можно переопределить переменными окружения) ───────────────────
APP_DIR="${SKYFRAZE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATE_DIR="${SKYFRAZE_STATE_DIR:-$APP_DIR/update-state}"
COMPOSE_FILE="${SKYFRAZE_COMPOSE:-docker-compose.prod.yml}"
REMOTE="${SKYFRAZE_REMOTE:-origin}"
BRANCH="${SKYFRAZE_BRANCH:-master}"
HEALTH_URL="${SKYFRAZE_HEALTH_URL:-http://127.0.0.1/api/health}"
TARGET="${1:-}"

STATUS_FILE="$STATE_DIR/status.json"
REQUEST_FILE="$STATE_DIR/request.json"
LOG_FILE="$STATE_DIR/update.log"
mkdir -p "$STATE_DIR"

# ── вспомогательные функции ──────────────────────────────────────────────────
log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE"
}

write_status() { # status message [target]
  local st="$1" msg="$2" target="${3:-}"
  cat > "$STATUS_FILE" <<EOF
{
  "status": "$st",
  "target": "$target",
  "message": "$msg",
  "started_at": "${STARTED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}",
  "ended_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "commit": "$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '')"
}
EOF
}

fail() {
  log "ОШИБКА: $*"
  write_status failed "$*" "$TARGET"
  exit 1
}

# ── что обновляем ───────────────────────────────────────────────────────────
if [ -z "$TARGET" ] && [ -f "$REQUEST_FILE" ]; then
  TARGET="$(sed -n 's/.*"target"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REQUEST_FILE" | head -1)"
  log "заявка из админки: цель '$TARGET'"
fi

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_status running "обновление началось" "$TARGET"

cd "$APP_DIR"
[ -f "$COMPOSE_FILE" ] || fail "нет $COMPOSE_FILE в $APP_DIR"
[ -d .git ] || fail "$APP_DIR не git-репозиторий: склонируйте проект (git clone), тогда обновление заработает"

log "каталог: $APP_DIR"
log "текущая ревизия: $(git rev-parse --short HEAD) ($(git describe --tags --always 2>/dev/null || echo без тегов))"

# Незакоммиченные правки в файлах кода мешают переключению — предупреждаем и
# сохраняем их в stash (данные пользователя тут не лежат: они в docker-томах).
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "локальные изменения: сохраняю в stash (git stash push -u)"
  git stash push -u -m "skyfraze-update $(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$LOG_FILE" 2>&1 || true
fi

log "git fetch --tags --prune $REMOTE"
git fetch --tags --prune "$REMOTE" >>"$LOG_FILE" 2>&1 || fail "git fetch не удался"

if [ -n "$TARGET" ]; then
  log "переключаюсь на $TARGET"
  git checkout --force "$TARGET" >>"$LOG_FILE" 2>&1 || fail "нет такого тега/ветки: $TARGET"
else
  log "переключаюсь на $REMOTE/$BRANCH"
  git checkout --force "$BRANCH" >>"$LOG_FILE" 2>&1 || true
  git reset --hard "$REMOTE/$BRANCH" >>"$LOG_FILE" 2>&1 || fail "git reset не удался"
fi
log "новая ревизия: $(git rev-parse --short HEAD) ($(git describe --tags --always 2>/dev/null || echo без тегов))"

# Сабмодули (deps/scroll-world) — только то, что нужно для сборки/документации.
log "git submodule update --init --recursive"
git submodule update --init --recursive >>"$LOG_FILE" 2>&1 || log "предупреждение: сабмодули не обновились"

# ── пересборка и перезапуск ─────────────────────────────────────────────────
log "docker compose -f $COMPOSE_FILE up -d --build"
docker compose -f "$COMPOSE_FILE" up -d --build >>"$LOG_FILE" 2>&1 || fail "docker compose up не удался"

# ── проверка, что поднялось ─────────────────────────────────────────────────
log "проверяю $HEALTH_URL"
OK=0
for i in $(seq 1 30); do
  if curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then OK=1; break; fi
  sleep 2
done
if [ "$OK" != "1" ]; then
  log "--- последние строки логов контейнеров ---"
  docker compose -f "$COMPOSE_FILE" logs --tail 40 >>"$LOG_FILE" 2>&1 || true
  fail "API не отвечает после обновления (см. update.log)"
fi

REV="$(git describe --tags --always 2>/dev/null || git rev-parse --short HEAD)"
log "готово: $REV"
write_status done "обновлено до $REV" "$TARGET"

# Заявку убираем, чтобы следующий запуск не повторил то же обновление.
rm -f "$REQUEST_FILE"
