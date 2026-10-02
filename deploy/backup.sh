#!/usr/bin/env bash
# Резервная копия SkyFraze: база данных + каталог вложений.
#
#   bash deploy/backup.sh                    сделать копию
#   bash deploy/backup.sh --drill [каталог]  проверить, что копия ВОССТАНАВЛИВАЕТСЯ
#
# Зачем это отдельным скриптом. Файлы и база живут в двух разных томах, и без копии
# они существуют в одном экземпляре: кончился диск, сгорела машина, «удалил не тот
# проект» — вернуть нечего. Объектное хранилище (docs/storage-s3.md) эту задачу не
# решает: те же байты, и MinIO на том же диске умирает вместе с ним.
#
# Что получается: каталог backups/<дата-время>/ с четырьмя файлами —
#
#   db.dump        pg_dump -Fc (восстанавливается pg_restore)
#   db.toc         оглавление дампа: список таблиц и объектов, читается глазами
#   assets.tar.gz  каталог вложений целиком
#   manifest.txt   что и когда снято, размеры, контрольные суммы
#   SHA256SUMS     контрольные суммы файлов копии
#
# Порядок важен: СНАЧАЛА база, потом файлы. Если снимать наоборот, между двумя
# шагами успеет появиться файл, строка о котором попадёт в дамп, — и в копии окажется
# вложение без файла (кадр с пустым местом). Обратный случай безвреден: лишний файл
# без строки уборщик удалит сам.
#
# Офсайт. Пока копия лежит на той же машине, от потери машины она не спасает.
# BACKUP_RSYNC=user@host:/path (нужен rsync на обоих концах) или
# BACKUP_RCLONE=remote:path (нужен rclone — он же умеет S3 и прочие облака).
#
# Проверка восстановления. `--drill` разворачивает копию в ОТДЕЛЬНУЮ базу и во
# временный каталог, сверяет, что у каждого вложения из базы есть файл в архиве, и
# убирает за собой. Копия, которую не восстанавливали, копией не считается.

set -euo pipefail

APP_DIR="${SKYFRAZE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
COMPOSE_FILE="${SKYFRAZE_COMPOSE:-docker-compose.prod.yml}"
PG_SERVICE="${SKYFRAZE_PG_SERVICE:-postgres}"
BACKEND_SERVICE="${SKYFRAZE_BACKEND_SERVICE:-backend}"
DB_USER="${SKYFRAZE_DB_USER:-skyfraze}"
DB_NAME="${SKYFRAZE_DB_NAME:-skyfraze}"
STORAGE_PATH="${SKYFRAZE_STORAGE_PATH:-/app/storage}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
# Сколько копий хранить на месте: чаще всего нужны последние дни, а не все сразу.
BACKUP_KEEP="${BACKUP_KEEP:-7}"
BACKUP_RSYNC="${BACKUP_RSYNC:-}"
BACKUP_RCLONE="${BACKUP_RCLONE:-}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
fail() { printf 'ошибка: %s\n' "$*" >&2; exit 1; }

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

cd "$APP_DIR"
[ -f "$COMPOSE_FILE" ] || fail "нет $COMPOSE_FILE (запускать из каталога стенда)"

# psql в контейнере базы: один запрос, значение без заголовков.
psql_at() {
  compose exec -T "$PG_SERVICE" psql -U "$DB_USER" -d "${2:-$DB_NAME}" -At -c "$1"
}

newest_backup() {
  find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d -name '20*' 2>/dev/null | sort | tail -1
}

# Системные аккаунты (агент «Нестор») — не люди: колонка users.is_system появилась в
# миграции 0011. В манифесте рядом с проектами должно стоять число людей, иначе
# «пользователей: 3» на инсталляции с двумя живыми авторами читается как ошибка.
#
# Колонки может не быть: этот же скрипт запускают и на развёртывании постарше (в том
# числе из свежего чекаута). Тогда все аккаунты — люди, и запрос с is_system просто
# упал бы — а с `set -e` это остановило бы копирование.
has_system_column() {
  [ "$(psql_at "SELECT count(*) FROM information_schema.columns
                 WHERE table_name = 'users' AND column_name = 'is_system'" "${1:-$DB_NAME}")" = "1" ]
}

count_people() {
  if has_system_column "${1:-}"; then
    psql_at 'SELECT count(*) FROM users WHERE NOT is_system' "${1:-$DB_NAME}"
  else
    psql_at 'SELECT count(*) FROM users' "${1:-$DB_NAME}"
  fi
}

count_system() {
  if has_system_column "${1:-}"; then
    psql_at 'SELECT count(*) FROM users WHERE is_system' "${1:-$DB_NAME}"
  else
    echo 0
  fi
}

# Временные объекты проверки восстановления. Держим их не локальными переменными, а
# переменными скрипта: trap срабатывает при выходе, когда локальных уже нет, и
# `set -u` валил уборку («unpack: unbound variable») — временная база оставалась
# в Postgres, а каталог на диске не удалялся.
DRILL_DB=""
DRILL_DIR=""

cleanup_drill() {
  if [ -n "$DRILL_DIR" ]; then
    rm -rf "$DRILL_DIR"
  fi
  if [ -n "$DRILL_DB" ]; then
    compose exec -T "$PG_SERVICE" dropdb -U "$DB_USER" --if-exists "$DRILL_DB" >/dev/null 2>&1 || true
  fi
  return 0
}

# ---------- создание копии ----------

create_backup() {
  local stamp dir
  stamp="$(date '+%Y-%m-%d_%H%M%S')"
  dir="$BACKUP_DIR/$stamp"
  mkdir -p "$dir"
  log "копия: $dir"

  # 1. База. -Fc — формат, который умеет восстанавливать отдельные таблицы.
  log "снимаю базу $DB_NAME"
  compose exec -T "$PG_SERVICE" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$dir/db.dump"
  [ -s "$dir/db.dump" ] || fail "дамп пустой — копия не сделана"
  # Оглавление сразу: им же проверяем, что дамп читается (иначе узнали бы об этом
  # только при восстановлении, когда уже поздно).
  compose exec -T "$PG_SERVICE" pg_restore -l < "$dir/db.dump" > "$dir/db.toc"
  grep -q 'TABLE DATA' "$dir/db.toc" || fail "в дампе нет данных таблиц — проверьте pg_restore -l"

  # 2. Файлы вложений — тем же контейнером, что их пишет: путь и владелец совпадают,
  # и не нужно угадывать имя docker-тома.
  log "упаковываю каталог вложений $STORAGE_PATH"
  compose exec -T "$BACKEND_SERVICE" tar czf - -C "$STORAGE_PATH" . > "$dir/assets.tar.gz"

  local projects assets users system events files
  projects="$(psql_at 'SELECT count(*) FROM projects')"
  assets="$(psql_at 'SELECT count(*) FROM assets')"
  users="$(count_people)"
  system="$(count_system)"
  events="$(psql_at 'SELECT count(*) FROM events')"
  files="$(tar tzf "$dir/assets.tar.gz" | grep -cv '/$' || true)"

  {
    echo "копия SkyFraze"
    echo "снято:        $(date '+%Y-%m-%d %H:%M:%S %z')"
    echo "хост:         $(hostname)"
    echo "каталог:      $APP_DIR"
    echo "версия:       $(git -C "$APP_DIR" describe --tags --always 2>/dev/null || echo 'не git-репозиторий')"
    echo "база:         $DB_NAME (pg_dump -Fc, $DB_USER)"
    echo "каталог файлов: $STORAGE_PATH"
    echo ""
    echo "проектов:     $projects"
    echo "пользователей: $users"
    if [ "$system" -gt 0 ]; then
      echo "системных:    $system (аккаунт агента, не человек)"
    fi
    echo "событий:      $events"
    echo "вложений:     $assets (строк в базе)"
    echo "файлов:       $files (в архиве)"
    echo ""
    echo "размеры:"
    du -h "$dir/db.dump" "$dir/assets.tar.gz" | sed 's/^/  /'
  } > "$dir/manifest.txt"

  ( cd "$dir" && sha256sum db.dump assets.tar.gz > SHA256SUMS )
  log "готово: $(du -sh "$dir" | cut -f1), проектов $projects, вложений $assets, файлов $files"

  rotate
  offsite "$dir"
  echo "$dir"
}

rotate() {
  [ "$BACKUP_KEEP" -gt 0 ] || { log "ротация выключена (BACKUP_KEEP=0)"; return; }
  local list
  list="$(find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d -name '20*' | sort -r)"
  local count
  count="$(printf '%s\n' "$list" | grep -c . || true)"
  if [ "$count" -le "$BACKUP_KEEP" ]; then
    log "копий на месте: $count (хранится $BACKUP_KEEP)"
    return
  fi
  printf '%s\n' "$list" | tail -n "+$((BACKUP_KEEP + 1))" | while read -r old; do
    [ -n "$old" ] || continue
    log "удаляю старую копию: $(basename "$old")"
    rm -rf "$old"
  done
}

offsite() {
  local dir="$1" name
  name="$(basename "$dir")"
  if [ -n "$BACKUP_RSYNC" ]; then
    command -v rsync >/dev/null || fail "BACKUP_RSYNC задан, но rsync не установлен"
    log "офсайт: rsync → $BACKUP_RSYNC"
    rsync -az --stats "$dir/" "$BACKUP_RSYNC/$name/" >/dev/null
    log "офсайт: копия отправлена"
    return
  fi
  if [ -n "$BACKUP_RCLONE" ]; then
    command -v rclone >/dev/null || fail "BACKUP_RCLONE задан, но rclone не установлен"
    log "офсайт: rclone → $BACKUP_RCLONE"
    rclone copy "$dir" "$BACKUP_RCLONE/$name"
    log "офсайт: копия отправлена"
    return
  fi
  log "офсайт не настроен: копия остаётся на этой же машине (BACKUP_RSYNC или BACKUP_RCLONE)"
}

# ---------- проверка восстановления ----------

drill() {
  local dir="${1:-}"
  [ -n "$dir" ] || dir="$(newest_backup)"
  [ -n "$dir" ] && [ -d "$dir" ] || fail "нет копий в $BACKUP_DIR"
  [ -f "$dir/db.dump" ] || fail "в $dir нет db.dump"

  local scratch
  scratch="skyfraze_drill_$(date '+%H%M%S')"
  DRILL_DB="$scratch"
  DRILL_DIR="$(mktemp -d)"
  local unpack="$DRILL_DIR"
  trap cleanup_drill EXIT

  log "проверяю копию: $dir"
  log "разворачиваю базу в отдельную $scratch (рабочая база не тронута)"
  compose exec -T "$PG_SERVICE" createdb -U "$DB_USER" "$scratch"
  compose exec -T "$PG_SERVICE" pg_restore -U "$DB_USER" -d "$scratch" --no-owner < "$dir/db.dump"

  log "распаковываю вложения во временный каталог"
  tar xzf "$dir/assets.tar.gz" -C "$unpack"

  local projects assets users system files missing
  projects="$(psql_at 'SELECT count(*) FROM projects' "$scratch")"
  assets="$(psql_at 'SELECT count(*) FROM assets' "$scratch")"
  users="$(count_people "$scratch")"
  system="$(count_system "$scratch")"
  files="$(find "$unpack" -type f | wc -l)"
  # Главная проверка: у каждой строки вложения в базе есть файл в архиве. Именно
  # этого не хватает, когда копию снимают в неверном порядке или «забыли» каталог.
  #
  # `sort -u`, а не `sort`: два вложения с одинаковым содержимым делят один файл
  # (дедупликация по content_hash), поэтому один и тот же ключ встречается в таблице
  # несколько раз. Без -u отсутствующий файл считался столько раз, сколько на него
  # ссылок, и в отчёте одна пропажа выглядела как восемнадцать.
  psql_at 'SELECT s3_key FROM assets' "$scratch" | sort -u > "$unpack/.keys_from_db"
  ( cd "$unpack" && find . -type f -printf '%P\n' | sort -u > .files_in_archive )
  missing="$(comm -23 "$unpack/.keys_from_db" "$unpack/.files_in_archive" | wc -l)"

  echo ""
  echo "=== копия $dir ==="
  echo "проектов:     $projects"
  echo "пользователей: $users"
  if [ "$system" -gt 0 ]; then
    echo "системных:    $system (аккаунт агента, не человек)"
  fi
  echo "вложений:     $assets"
  echo "файлов:       $files"
  echo "файлов нет у вложений: $missing"
  echo ""

  if [ "$missing" -gt 0 ]; then
    comm -23 "$unpack/.keys_from_db" "$unpack/.files_in_archive" | head -10 | sed 's/^/  нет файла: /'
    fail "копия неполная: у $missing вложений нет файлов"
  fi
  [ "$assets" -gt 0 ] && [ "$files" -eq 0 ] && fail "в архиве нет файлов, хотя в базе $assets вложений"
  log "проверка пройдена: копия восстанавливается, у всех вложений есть файлы"
}

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  --drill | drill) shift || true; drill "${1:-}" ;;
  "" ) create_backup ;;
  -h | --help | help) usage ;;
  *) fail "неизвестный аргумент: $1 (см. --help)" ;;
esac
