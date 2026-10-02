#!/usr/bin/env bash
# Разведка перед включением помощника на стенде: есть ли локальная модель и что в .env.
set -uo pipefail
cd /home/skyadmin/skyfraze

echo "health:      $(curl -s http://127.0.0.1/api/health)"
echo "health-поле: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/api/health)"

echo "--- локальная модель (Ollama) ---"
if command -v ollama >/dev/null 2>&1; then
  echo "ollama: есть ($(command -v ollama))"
else
  echo "ollama: в PATH нет"
fi
echo -n "юнит ollama: "; systemctl is-active ollama 2>/dev/null || echo "нет"
echo -n "порт 11434:  "; curl -s -m 2 http://127.0.0.1:11434/api/tags || echo "не отвечает"

echo "--- .env: настройки помощника ---"
grep -E '^AI_' .env || echo "AI_* не заданы (значит выключен по умолчанию)"

echo "--- контейнер backend: что видит помощник ---"
for v in AI_ENABLED AI_OLLAMA_URL AI_OPENAI_COMPAT_URL AI_DEFAULT_MODEL; do
  printf '%s: ' "$v"
  docker compose -f docker-compose.prod.yml exec -T backend printenv "$v" 2>/dev/null || echo "(не задана)"
done
printf 'AI_SECRET_KEY задан: '
if [ -n "$(docker compose -f docker-compose.prod.yml exec -T backend printenv AI_SECRET_KEY 2>/dev/null)" ]; then echo да; else echo нет; fi

echo "--- ресурсы машины (для локальной модели) ---"
echo "процессор: $(nproc) ядер"
free -h | head -2
df -h / | tail -1
