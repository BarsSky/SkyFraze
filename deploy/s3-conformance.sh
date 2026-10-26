#!/usr/bin/env bash
# s3-conformance.sh — проверить хранилище вложений СТЕНДА контрактом ObjectStore.
#
# Зачем это нужно, если в CI уже есть job storage-s3. В CI поднимается SeaweedFS:
# образы MinIO с октября 2025 анонимно не скачиваются (minio/minio удалён с Docker Hub,
# quay.io/minio/minio отвечает 401), поэтому боевой сервер стенда CI не проверяет. А
# проверять нужно именно его: сборка контейнера, ключи, бакет, права и TLS — это
# настройки стенда, а не кода, и тест на чужом сервере о них ничего не говорит.
#
# Что делает: берёт S3_* из .env стенда, поднимает контейнер с Go и прогоняет
# `TestS3StoreConformance` — запись, чтение, размер, перезапись, удаление, листинг,
# границы префикса, юникод в ключе. Всё пишется под временным префиксом
# `conf-<uuid>/` и удаляется тестом за собой; в `assets` строки не появляются.
#
# Про версионирование (важно для бакета вложений). Если на бакете включено
# версионирование (у боевого включено), удаление объекта оставляет неактуальную
# версию: байты живут в бакете до истечения правила noncurrent (30 дней, см.
# docs/storage-s3.md §11). На один прогон это ~100 КБ и полтора десятка версий —
# не проблема, но «ушёл бесследно» будет неправдой. Для регулярных прогонов лучше
# отдельный бакет: S3_CONFORMANCE_BUCKET=… (нужен свой пользователь с правами на него).
#
# Почему контейнер, а не `go test` на хосте: на стенде нет Go, а ставить его ради
# проверки — лишний пакет на боевой машине. Образ `golang:1.26` тянется один раз,
# кэш модулей и сборки живёт в томах docker и переиспользуется.
#
# Использование (на стенде, из каталога репозитория):
#   bash deploy/s3-conformance.sh            # спросит подтверждение
#   bash deploy/s3-conformance.sh --yes      # без вопроса (для таймера/CI-руннера)
#
# Ключи и адрес можно задать и снаружи, не трогая .env:
#   S3_TEST_ENDPOINT=... S3_TEST_ACCESS_KEY=... S3_TEST_SECRET_KEY=... \
#     bash deploy/s3-conformance.sh --yes
#
# Код возврата: 0 — контракт выполнен; 1 — провал или стенд настроен наполовину;
# 0 с сообщением «пропущено» — если хранилище стенда локальное (проверять нечего).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${S3_CONFORMANCE_IMAGE:-golang:1.26}"
MOD_CACHE_VOLUME="${S3_CONFORMANCE_MOD_CACHE:-skyfraze-s3conf-mod}"
BUILD_CACHE_VOLUME="${S3_CONFORMANCE_BUILD_CACHE:-skyfraze-s3conf-build}"
ASSUME_YES=0

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
fail() { printf 'ошибка: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "не знаю аргумент «$arg» (ожидаются --yes или --help)" ;;
  esac
done

# Настройки стенда — из .env (его читает docker compose). Разбираем построчно, как
# deploy/backup.sh: значения с кавычками, CRLF и BOM не должны ломать запуск.
ENV_S3_ENDPOINT=""
ENV_S3_BUCKET=""
ENV_S3_KEY=""
ENV_S3_SECRET=""
ENV_S3_REGION=""
ENV_S3_USE_SSL=""
ENV_STORAGE_DRIVER=""
load_env() {
  local file="$APP_DIR/.env"
  [ -f "$file" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#$'\xEF\xBB\xBF'}"
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"
    case "$key" in
      STORAGE_DRIVER)     ENV_STORAGE_DRIVER="$val" ;;
      S3_ENDPOINT)        ENV_S3_ENDPOINT="$val" ;;
      S3_BUCKET)          ENV_S3_BUCKET="$val" ;;
      S3_KEY)             ENV_S3_KEY="$val" ;;
      S3_SECRET)          ENV_S3_SECRET="$val" ;;
      S3_REGION)          ENV_S3_REGION="$val" ;;
      S3_USE_SSL)         ENV_S3_USE_SSL="$val" ;;
    esac
  done < "$file"
}
load_env

# Снаружи заданное важнее файла: так скрипт можно навести на другой стенд или на
# отдельный бакет, не правя .env боевой машины.
ENDPOINT="${S3_TEST_ENDPOINT:-$ENV_S3_ENDPOINT}"
BUCKET="${S3_TEST_BUCKET:-${S3_CONFORMANCE_BUCKET:-$ENV_S3_BUCKET}}"
ACCESS_KEY="${S3_TEST_ACCESS_KEY:-$ENV_S3_KEY}"
SECRET_KEY="${S3_TEST_SECRET_KEY:-$ENV_S3_SECRET}"
REGION="${S3_TEST_REGION:-$ENV_S3_REGION}"

if [ -z "$ENDPOINT" ] || [ -z "$BUCKET" ]; then
  if [ "$ENV_STORAGE_DRIVER" = "s3" ]; then
    fail "STORAGE_DRIVER=s3, но S3_ENDPOINT/S3_BUCKET не заданы — стенд настроен наполовину"
  fi
  log "хранилище стенда локальное (STORAGE_DRIVER=${ENV_STORAGE_DRIVER:-local}) — проверять нечего"
  exit 0
fi
[ -n "$ACCESS_KEY" ] && [ -n "$SECRET_KEY" ] || fail "S3_KEY/S3_SECRET не заданы: без ключей проверка невозможна"
case "$ENDPOINT" in
  *://*) : ;;
  *)
    # Значение без схемы: S3_USE_SSL решает, https или http (та же логика, что в storage.NewS3).
    if [ "$ENV_S3_USE_SSL" = "true" ]; then
      ENDPOINT="https://$ENDPOINT"
    else
      ENDPOINT="http://$ENDPOINT"
    fi
    ;;
esac

command -v docker >/dev/null 2>&1 || fail "docker не найден: проверка идёт в контейнере $IMAGE"
[ -d "$APP_DIR/backend" ] || fail "не нашёл $APP_DIR/backend — запускать нужно из репозитория SkyFraze"

log "контракт ObjectStore против хранилища стенда"
log "  endpoint: $ENDPOINT"
log "  бакет:    $BUCKET"
log "  пишет:    временный префикс conf-<uuid>/, убирает за собой"
log "  образ:    $IMAGE"
if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Продолжить? [y/N] '
  read -r answer || answer=""
  case "$answer" in
    y|Y|yes|YES) : ;;
    *) log "отменено"; exit 0 ;;
  esac
fi

# --network host: S3 может быть на localhost (minio рядом в compose) — из контейнера
# 127.0.0.1 указывал бы на сам контейнер, и проверка «не нашла» бы сервер.
log "запускаю go test ./internal/storage/ (TestS3StoreConformance)"
set +e
docker run --rm --network host \
  -v "$APP_DIR/backend:/src:ro" \
  -v "$MOD_CACHE_VOLUME:/go/pkg/mod" \
  -v "$BUILD_CACHE_VOLUME:/root/.cache/go-build" \
  -w /src \
  -e S3_TEST_ENDPOINT="$ENDPOINT" \
  -e S3_TEST_BUCKET="$BUCKET" \
  -e S3_TEST_ACCESS_KEY="$ACCESS_KEY" \
  -e S3_TEST_SECRET_KEY="$SECRET_KEY" \
  -e S3_TEST_REGION="$REGION" \
  "$IMAGE" go test ./internal/storage/ -run TestS3StoreConformance -count=1 -v
status=$?
set -e

if [ "$status" -eq 0 ]; then
  log "контракт выполнен: хранилище стенда ведёт себя как обещает ObjectStore"
  if [ -n "$ENV_S3_BUCKET" ] && [ "$BUCKET" = "$ENV_S3_BUCKET" ]; then
    log "прогон шёл в бакет вложений: удалённые тестовые объекты остались неактуальными"
    log "версиями (~100 КБ) до истечения правила noncurrent (30 дней). Для регулярных"
    log "прогонов заведите отдельный бакет: S3_CONFORMANCE_BUCKET=…"
  fi
else
  log "контракт НЕ выполнен (код $status): смотри вывод выше"
  log "частые причины: неверные ключи (403), нет бакета (NoSuchBucket),"
  log "TLS не принимается контейнером (сертификат), адрес недоступен из контейнера"
fi
exit "$status"
