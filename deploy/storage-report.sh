#!/usr/bin/env bash
# Отчёт о хранении: сколько места занимает база, снапшоты, текст и вложения.
#
#   bash deploy/storage-report.sh
#
# Запускается на хосте со стендом (там же, где docker-compose.prod.yml). Числа —
# первое, что нужно перед любой оптимизацией; что с ними делать, написано в
# docs/storage-compression.md.

set -euo pipefail

APP_DIR="${SKYFRAZE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
COMPOSE_FILE="${SKYFRAZE_COMPOSE:-docker-compose.prod.yml}"
DB_USER="${SKYFRAZE_DB_USER:-skyfraze}"
DB_NAME="${SKYFRAZE_DB_NAME:-skyfraze}"
STORAGE_DIR="${SKYFRAZE_STORAGE_DIR:-}"

cd "$APP_DIR"

echo "=== База (отчёт SQL) ==="
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  psql -U "$DB_USER" -d "$DB_NAME" -f - < "$APP_DIR/deploy/storage-report.sql"

echo ""
echo "=== Файлы в каталоге хранилища ==="
if [ -n "$STORAGE_DIR" ] && [ -d "$STORAGE_DIR" ]; then
  du -sh "$STORAGE_DIR"
  echo "файлов: $(find "$STORAGE_DIR" -type f | wc -l)"
else
  # Каталог обычно лежит в docker-томе: считаем по контейнеру.
  docker compose -f "$COMPOSE_FILE" exec -T backend sh -c \
    'du -sh "${STORAGE_DIR:-/app/storage}"; printf "файлов: %s\n" "$(find "${STORAGE_DIR:-/app/storage}" -type f | wc -l)"'
fi

echo ""
echo "=== Сверка каталога с базой и уборка ==="
echo "Список файлов без строк в assets и удаление ненужных — в админке:"
echo "  GET  /api/admin/storage        посмотреть отчёт со сверкой"
echo "  POST /api/admin/storage/sweep  убрать файлы, на которые никто не ссылается"
