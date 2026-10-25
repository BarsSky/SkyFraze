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
# Утилиту ищем в PATH, а потом в ~/.local/bin: без root rclone ставится только туда,
# а PATH пользовательского юнита systemd этот каталог не содержит.
#
# Пример S3 (MinIO на NAS, отдельный бакет под этот стенд):
#   BACKUP_RCLONE=skyfraze:skyfraze
# где [skyfraze] — remote в ~/.config/rclone/rclone.conf (type=s3, provider=Minio,
# endpoint, ключи), а skyfraze после двоеточия — бакет. Копия ложится в
# skyfraze:skyfraze/<дата-время>/, ровно теми же файлами, что лежат локально.
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
# Что задано в окружении — то главнее файла настроек (см. load_backup_env ниже).
# Запоминаем ДО подстановки значений по умолчанию: иначе «заданным снаружи» выглядел бы
# и сам дефолт, и файл не смог бы ничего изменить.
ENV_BACKUP_DIR="${BACKUP_DIR:-}"
ENV_BACKUP_KEEP="${BACKUP_KEEP:-}"
ENV_BACKUP_RSYNC="${BACKUP_RSYNC:-}"
ENV_BACKUP_RCLONE="${BACKUP_RCLONE:-}"
ENV_BACKUP_RCLONE_KEEP="${BACKUP_RCLONE_KEEP:-}"
ENV_BACKUP_KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-}"
ENV_BACKUP_KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-}"
ENV_BACKUP_ASSETS_RCLONE="${BACKUP_ASSETS_RCLONE:-}"

BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
# Сколько копий хранить на месте: чаще всего нужны последние дни, а не все сразу.
BACKUP_KEEP="${BACKUP_KEEP:-7}"
BACKUP_RSYNC="${BACKUP_RSYNC:-}"
BACKUP_RCLONE="${BACKUP_RCLONE:-}"
# Сколько копий хранить в офсайте (только для rclone). 0 — не удалять ничего.
#
# Зачем вообще: локальная ротация (BACKUP_KEEP) к офсайту не относится — `rclone copy`
# только добавляет. Без этой настройки бакет растёт вечно: у стенда это ~6 МБ в день,
# то есть ~2 ГБ в год, и растёт он вместе с вложениями. По умолчанию 0 (ничего не
# удаляем): удалять данные в чужом хранилище скрипт не должен без явного разрешения.
BACKUP_RCLONE_KEEP="${BACKUP_RCLONE_KEEP:-0}"
# Второй уровень хранения на месте: недельные (воскресенье) и месячные (первое число) копии.
# 0 — уровень не ведётся. Смысл: семь дней ежедневных не отвечают на «верни состояние месяц
# назад», а история версий проекта — про правки, а не про восстановление после аварии.
BACKUP_KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
BACKUP_KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-3}"
# Тестовая зацепка (не для стенда): создать уровень независимо от дня недели.
BACKUP_FORCE_TIER="${BACKUP_FORCE_TIER:-}"
# Откуда брать вложения, если они лежат в S3 (STORAGE_DRIVER=s3): `remote:path` для
# rclone, указывающий на КОРЕНЬ бакета вложений. Пусто — вложения читаются с диска
# (обычный случай). Без этой строки при S3-хранилище в копию попала бы только база.
BACKUP_ASSETS_RCLONE="${BACKUP_ASSETS_RCLONE:-}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
fail() { printf 'ошибка: %s\n' "$*" >&2; exit 1; }

# Настройки стенда — отдельный файл $APP_DIR/backup.env (не в репозитории).
#
# Почему не .env. BACKUP_* — это переменные окружения скрипта, а .env читает только
# docker compose: строка BACKUP_RSYNC, дописанная туда, не делала бы НИЧЕГО, и копии
# молча оставались бы на той же машине (об этом же говорит отчёт «офсайт не настроен»,
# но его видно только в журнале). Отдельный файл читает сам скрипт, поэтому и ручной
# запуск, и запуск из-под таймера видят одни и те же настройки.
#
# Формат — KEY=VALUE, по строке на настройку, `#` — комментарий. Образец:
# deploy/backup.env.example. Путь можно переопределить: SKYFRAZE_BACKUP_ENV=/etc/...
load_backup_env() {
  local file="${SKYFRAZE_BACKUP_ENV:-$APP_DIR/backup.env}"
  [ -f "$file" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}" # файл могли сохранить на Windows: CRLF
    line="${line#$'\xEF\xBB\xBF'}" # и BOM в первой строке
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    val="${val%\"}"; val="${val#\"}"   # кавычки вокруг значения не обязательны,
    val="${val%\'}"; val="${val#\'}"   # но если есть — снимаем
    case "$key" in
      BACKUP_DIR)    [ -n "$ENV_BACKUP_DIR" ]    || BACKUP_DIR="$val" ;;
      BACKUP_KEEP)   [ -n "$ENV_BACKUP_KEEP" ]   || BACKUP_KEEP="$val" ;;
      BACKUP_RSYNC)  [ -n "$ENV_BACKUP_RSYNC" ]  || BACKUP_RSYNC="$val" ;;
      BACKUP_RCLONE) [ -n "$ENV_BACKUP_RCLONE" ] || BACKUP_RCLONE="$val" ;;
      BACKUP_RCLONE_KEEP) [ -n "$ENV_BACKUP_RCLONE_KEEP" ] || BACKUP_RCLONE_KEEP="$val" ;;
      BACKUP_KEEP_WEEKLY) [ -n "$ENV_BACKUP_KEEP_WEEKLY" ] || BACKUP_KEEP_WEEKLY="$val" ;;
      BACKUP_KEEP_MONTHLY) [ -n "$ENV_BACKUP_KEEP_MONTHLY" ] || BACKUP_KEEP_MONTHLY="$val" ;;
      BACKUP_ASSETS_RCLONE) [ -n "$ENV_BACKUP_ASSETS_RCLONE" ] || BACKUP_ASSETS_RCLONE="$val" ;;
      *) log "backup.env: не знаю настройку «$key» — ожидаются BACKUP_DIR, BACKUP_KEEP, BACKUP_KEEP_WEEKLY, BACKUP_KEEP_MONTHLY, BACKUP_RSYNC, BACKUP_RCLONE, BACKUP_RCLONE_KEEP, BACKUP_ASSETS_RCLONE" ;;
    esac
  done < "$file"
}

load_backup_env

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

cd "$APP_DIR"
[ -f "$COMPOSE_FILE" ] || fail "нет $COMPOSE_FILE (запускать из каталога стенда)"

# psql в контейнере базы: один запрос, значение без заголовков.
psql_at() {
  compose exec -T "$PG_SERVICE" psql -U "$DB_USER" -d "${2:-$DB_NAME}" -At -c "$1"
}

# Проверяем свежую ЕЖЕДНЕВНУЮ копию, а не уровневую: уровни — это те же данные, но
# проверять надо то, что снимается каждый день. Если ежедневных нет (все удалены), берётся
# любая.
newest_backup() {
  local daily tiered
  daily="$(find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d -name '20*' 2>/dev/null \
           | grep -E '/20[0-9]{2}-[0-9]{2}-[0-9]{2}_[0-9]{6}$' | sort | tail -1)"
  if [ -n "$daily" ]; then
    printf '%s\n' "$daily"
    return 0
  fi
  tiered="$(find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d -name '20*' 2>/dev/null | sort | tail -1)"
  [ -n "$tiered" ] && printf '%s\n' "$tiered"
}

# tool_path — где лежит внешняя утилита: сначала PATH, потом ~/.local/bin.
#
# Зачем второй вариант. rclone (офсайт в S3) часто приходится ставить БЕЗ root —
# распаковать статический бинарник больше некуда, а sudo на стенде может быть
# недоступен. Но PATH пользовательского юнита systemd — это
# /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin, и ~/.local/bin в нём
# нет: ручной запуск из шелла копию отправил бы, а таймер — нет, и разница вылезла
# бы только в журнале ночью. Поэтому ищем сами, а не надеемся на PATH.
tool_path() {
  local name="$1" found
  if found="$(command -v "$name" 2>/dev/null)" && [ -n "$found" ]; then
    printf '%s\n' "$found"
    return 0
  fi
  if [ -x "$HOME/.local/bin/$name" ]; then
    printf '%s\n' "$HOME/.local/bin/$name"
    return 0
  fi
  return 1
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

  # 2. Файлы вложений.
  #
  #    С диска — тем же контейнером, что их пишет: путь и владелец совпадают, и не нужно
  #    угадывать имя docker-тома. Из S3 (STORAGE_DRIVER=s3) — скачиваем бакет rclone'ом и
  #    упаковываем те же ключи: без этого в копии оказалась бы только база, а вложения
  #    остались бы одной копией в бакете — и проверка восстановления честно упала бы на
  #    «файлов нет у вложений». То есть архив обязан быть полным ЛЮБЫМ путём.
  if [ -n "$BACKUP_ASSETS_RCLONE" ]; then
    local tool
    tool="$(tool_path rclone)" || fail "BACKUP_ASSETS_RCLONE задан, но rclone не установлен"
    log "скачиваю вложения из S3: $BACKUP_ASSETS_RCLONE"
    local scratch="$dir/.assets"
    mkdir -p "$scratch"
    "$tool" copy "$BACKUP_ASSETS_RCLONE" "$scratch" || fail "не удалось скачать вложения из S3"
    tar czf "$dir/assets.tar.gz" -C "$scratch" .
    rm -rf "$scratch"
  else
    log "упаковываю каталог вложений $STORAGE_PATH"
    compose exec -T "$BACKEND_SERVICE" tar czf - -C "$STORAGE_PATH" . > "$dir/assets.tar.gz"
  fi

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

  make_tiered "$dir"
  rotate
  offsite "$dir"
  echo "$dir"
}

# make_tiered — второй уровень хранения: недельные и месячные копии.
#
# Зачем. Ежедневные копии живут 7–14 дней, и «верни состояние месяц назад» ими не решается:
# история версий проекта — это другое (она про правки, а не про восстановление после аварии).
# Поэтому в воскресенье копия дополнительно кладётся с суффиксом `-w`, а первого числа —
# с `-m`; срок хранения у этих уровней свой (BACKUP_KEEP_WEEKLY / BACKUP_KEEP_MONTHLY).
#
# Копия делается ЖЁСТКИМИ ССЫЛКАМИ (`cp -al`), а не копированием: файлы те же, место не
# удваивается, а удаление ежедневной копии не ломает недельную — inode живёт, пока на него
# есть ссылка. Если ФС не умеет (или это не локальный диск) — обычное копирование.
#
# Тестовая зацепка: BACKUP_FORCE_TIER=weekly|monthly позволяет создать уровень в любой день,
# не ждя воскресенья. Без неё проверять ротацию пришлось бы неделей ожидания.
make_tiered() {
  local daily="$1" stamp suffix dest
  stamp="$(basename "$daily")"
  suffix=""
  if [ "${BACKUP_FORCE_TIER:-}" = "monthly" ] || [ "$(date '+%d')" = "01" ]; then
    suffix="m"
  elif [ "${BACKUP_FORCE_TIER:-}" = "weekly" ] || [ "$(date '+%u')" = "7" ]; then
    suffix="w"
  fi
  [ -n "$suffix" ] || return 0
  dest="$BACKUP_DIR/${stamp}-${suffix}"
  [ -d "$dest" ] && return 0
  if cp -al "$daily" "$dest" 2>/dev/null; then
    log "уровень хранения: $(basename "$dest") (жёсткие ссылки)"
  else
    cp -a "$daily" "$dest"
    log "уровень хранения: $(basename "$dest") (копия)"
  fi
}

# rotate — сроки хранения по уровням.
#
# Три независимых правила, а не одно общее: ежедневные, недельные (`-w`) и месячные (`-m`)
# копии живут по своим числам, иначе месяц истории вытеснялся бы семью днями.
#
# Тестовая зацепка: именованные переменные KEEP уже позволяют прогнать ротацию с малыми
# числами и посмотреть, что останется.
rotate() {
  rotate_kind '^20[0-9]{2}-[0-9]{2}-[0-9]{2}_[0-9]{6}$'     "$BACKUP_KEEP"         "ежедневных"
  rotate_kind '^20[0-9]{2}-[0-9]{2}-[0-9]{2}_[0-9]{6}-w$'   "$BACKUP_KEEP_WEEKLY"  "недельных"
  rotate_kind '^20[0-9]{2}-[0-9]{2}-[0-9]{2}_[0-9]{6}-m$'   "$BACKUP_KEEP_MONTHLY" "месячных"
}

# rotate_kind — оставить последние keep каталогов, чьё ИМЯ подходит под regex.
#
# Регулярное выражение, а не `case`: в `case` работают глобы, и шаблон вида `[0-9]{6}` там
# означает совсем другое — первая версия на этом и провалилась (ротация не удаляла ничего,
# и самопроверка ниже это поймала, а не живой стенд). Имя, а не полный путь: якоря `^`/`$`
# должны относиться к имени каталога.
rotate_kind() {
  local pattern="$1" keep="$2" label="$3" list count
  if [ "$keep" -le 0 ]; then
    log "ротация $label выключена ($keep)"
    return 0
  fi
  # `|| true` обязателен: если каталогов этого уровня ещё нет, grep выходит с 1, а с
  # `set -euo pipefail` неудачное присваивание убивает весь скрипт — копия создана, а
  # офсайт и остальные уровни уже не выполнятся (именно так и случилось на первом прогоне
  # с месячным уровнем: копия легла на место, а в бакет не уехала).
  list="$(find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d -printf '%f\n' 2>/dev/null \
          | grep -E "$pattern" || true)"
  list="$(printf '%s\n' "$list" | grep . | sort -r || true)"
  count="$(printf '%s\n' "$list" | grep -c . || true)"
  if [ "$count" -le "$keep" ]; then
    log "копий $label: $count (хранится $keep)"
    return 0
  fi
  printf '%s\n' "$list" | tail -n "+$((keep + 1))" | while read -r old; do
    [ -n "$old" ] || continue
    log "удаляю старую копию: $old"
    rm -rf "$BACKUP_DIR/$old"
  done
}

offsite() {
  local dir="$1" name tool
  name="$(basename "$dir")"
  if [ -n "$BACKUP_RSYNC" ]; then
    tool="$(tool_path rsync)" || fail "BACKUP_RSYNC задан, но rsync не установлен"
    log "офсайт: rsync → $BACKUP_RSYNC"
    "$tool" -az --stats "$dir/" "$BACKUP_RSYNC/$name/" >/dev/null
    log "офсайт: копия отправлена"
    return
  fi
  if [ -n "$BACKUP_RCLONE" ]; then
    tool="$(tool_path rclone)" || fail "BACKUP_RCLONE задан, но rclone не установлен (PATH или ~/.local/bin)"
    log "офсайт: rclone → $BACKUP_RCLONE"
    "$tool" copy "$dir" "$BACKUP_RCLONE/$name"
    log "офсайт: копия отправлена"
    # Уровневые копии (недельная/месячная) — тоже в офсайт: иначе «месяц назад» было бы
    # только на той же машине, то есть ровно там, где его и потеряют.
    local tier
    for tier in "$dir"-w "$dir"-m; do
      [ -d "$tier" ] || continue
      "$tool" copy "$tier" "$BACKUP_RCLONE/$(basename "$tier")" >/dev/null
      log "офсайт: уровень $(basename "$tier") отправлен"
    done
    rotate_offsite "$tool"
    return
  fi
  log "офсайт не настроен: копия остаётся на этой же машине (BACKUP_RSYNC или BACKUP_RCLONE)"
}

# rotate_offsite — сроки хранения в бакете, по уровням, как и на месте.
#
# Удаляются ТОЛЬКО каталоги с именем-датой (для своего уровня): в бакете могут лежать чужие
# объекты, и «ротация всего, что найдём» была бы уборкой не в своём шкафу. Свежая копия не
# трогается никогда — она в списке первая. Уровневые копии (`-w`, `-m`) считаются отдельно и
# отдельно же удаляются: иначе месячная копия вылетала бы как «старая ежедневная».
rotate_offsite() {
  local tool="$1"
  [ "$BACKUP_RCLONE_KEEP" -gt 0 ] || return 0
  rotate_offsite_kind "$tool" '[0-9]{6}$'     "$BACKUP_RCLONE_KEEP"         "ежедневных"
  rotate_offsite_kind "$tool" '[0-9]{6}-w$'   "$BACKUP_KEEP_WEEKLY"          "недельных"
  rotate_offsite_kind "$tool" '[0-9]{6}-m$'   "$BACKUP_KEEP_MONTHLY"         "месячных"
}

rotate_offsite_kind() {
  local tool="$1" pattern="$2" keep="$3" label="$4" list count
  [ "$keep" -gt 0 ] || return 0
  # sort -r — от новых к старым, как у локальной ротации.
  list="$("$tool" lsf --dirs-only "$BACKUP_RCLONE" 2>/dev/null | sed 's#/$##' \
          | grep -E "^20[0-9]{2}-[0-9]{2}-[0-9]{2}_${pattern}" | sort -r)"
  count="$(printf '%s\n' "$list" | grep -c . || true)"
  if [ "$count" -le "$keep" ]; then
    log "офсайт: копий $label: $count (хранится $keep)"
    return 0
  fi
  printf '%s\n' "$list" | tail -n "+$((keep + 1))" | while read -r old; do
    [ -n "$old" ] || continue
    log "офсайт: удаляю старую копию $old ($label, хранится $keep)"
    "$tool" purge "$BACKUP_RCLONE/$old" >/dev/null
  done
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

# ---------- самопроверка ротации ----------

# self_test — проверка уровней хранения на временном каталоге.
#
# Зачем: ротация удаляет данные, и «посмотреть глазами на живом стенде» здесь плохой метод —
# ошибка стоит реальных копий. Тест создаёт пустые каталоги с именами как у копий, прогоняет
# ту же функцию rotate, что работает на стенде, и сверяет, что осталось. Реальный каталог
# копий не трогается вовсе.
#
# Запуск: bash deploy/backup.sh --self-test
self_test() {
  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT
  BACKUP_DIR="$tmp"

  # 10 ежедневных, 6 недельных, 4 месячных — заведомо больше любых пределов.
  local i
  for i in $(seq 1 10); do mkdir -p "$tmp/2026-09-$(printf '%02d' "$i")_030000"; done
  for i in $(seq 1 6); do mkdir -p "$tmp/2026-08-$(printf '%02d' "$i")_030000-w"; done
  for i in $(seq 1 4); do mkdir -p "$tmp/2026-07-$(printf '%02d' "$i")_030000-m"; done

  BACKUP_KEEP=3 BACKUP_KEEP_WEEKLY=2 BACKUP_KEEP_MONTHLY=1 rotate >/dev/null

  local daily weekly monthly ok=0
  daily="$(find "$tmp" -maxdepth 1 -mindepth 1 -type d -name '20*' | grep -cE '[0-9]{6}$' || true)"
  weekly="$(find "$tmp" -maxdepth 1 -mindepth 1 -type d -name '20*' | grep -cE '[0-9]{6}-w$' || true)"
  monthly="$(find "$tmp" -maxdepth 1 -mindepth 1 -type d -name '20*' | grep -cE '[0-9]{6}-m$' || true)"

  check_kind() {
    local label="$1" got="$2" want="$3"
    if [ "$got" = "$want" ]; then
      printf '  %-12s %s (ожидалось %s) — ok\n' "$label" "$got" "$want"
    else
      printf '  %-12s %s (ожидалось %s) — ПРОВАЛ\n' "$label" "$got" "$want"
      ok=1
    fi
  }
  check_kind "ежедневных" "$daily" 3
  check_kind "недельных" "$weekly" 2
  check_kind "месячных" "$monthly" 1

  # Уровни не должны вытесняться ежедневными: месячные копии старше всех и обязаны выжить.
  if find "$tmp" -maxdepth 1 -type d -name '2026-07-*-m' | grep -q .; then
    printf '  месячный уровень пережил ротацию — ok\n'
  else
    printf '  месячный уровень удалён вместе с ежедневными — ПРОВАЛ\n'
    ok=1
  fi

  # Второй проход — БЕЗ уровневых каталогов. Это отдельная проверка, и она появилась после
  # реальной ошибки: когда недельных/месячных копий ещё нет, `grep` в фильтре выходит с 1, и
  # с `set -euo pipefail` скрипт умирал прямо в ротации — копия создана, а офсайт уже нет.
  # Живой прогон это поймал; самопроверка тогда молчала, потому что проверяла только случай
  # «все уровни есть».
  local tmp2
  tmp2="$(mktemp -d)"
  BACKUP_DIR="$tmp2"
  for i in $(seq 1 4); do mkdir -p "$tmp2/2026-09-$(printf '%02d' "$i")_030000"; done
  if BACKUP_KEEP=2 BACKUP_KEEP_WEEKLY=2 BACKUP_KEEP_MONTHLY=2 rotate >/dev/null 2>&1; then
    printf '  ротация без уровневых копий не падает — ok\n'
  else
    printf '  ротация без уровневых копий упала (pipefail на пустом grep) — ПРОВАЛ\n'
    ok=1
  fi
  rm -rf "$tmp2"
  BACKUP_DIR="$tmp"

  # make_tiered: с зацепкой BACKUP_FORCE_TIER уровень создаётся в любой день и только один раз.
  mkdir -p "$tmp/2026-10-25_120000"
  BACKUP_FORCE_TIER=weekly make_tiered "$tmp/2026-10-25_120000" >/dev/null
  if [ -d "$tmp/2026-10-25_120000-w" ]; then
    printf '  недельный уровень создаётся — ok\n'
  else
    printf '  недельный уровень не создан — ПРОВАЛ\n'
    ok=1
  fi
  BACKUP_FORCE_TIER=weekly make_tiered "$tmp/2026-10-25_120000" >/dev/null
  if [ "$(find "$tmp" -maxdepth 1 -type d -name '2026-10-25_120000-w' | wc -l)" = "1" ]; then
    printf '  повторный вызов не создаёт дубль — ok\n'
  else
    printf '  повторный вызов создал дубль — ПРОВАЛ\n'
    ok=1
  fi

  if [ "$ok" = "0" ]; then
    log "самопроверка ротации пройдена"
    return 0
  fi
  fail "самопроверка ротации не пройдена"
}
case "${1:-}" in
  --drill | drill) shift || true; drill "${1:-}" ;;
  --self-test | self-test) self_test ;;
  "" ) create_backup ;;
  -h | --help | help) usage ;;
  *) fail "неизвестный аргумент: $1 (см. --help)" ;;
esac

