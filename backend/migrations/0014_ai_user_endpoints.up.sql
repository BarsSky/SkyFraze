-- 0014: свои серверы моделей у пользователя.
--
-- Зачем. До сих пор список провайдеров собирался ТОЛЬКО из окружения стенда
-- (AI_OLLAMA_URL, AI_OPENAI_COMPAT_URL) — то есть адрес сервера моделей задавал админ.
-- Свой сервер (llama.cpp на домашней машине, vLLM в другой сети, Ollama на ноутбуке)
-- подключить было негде: в настройках помощника можно было выбрать провайдера из списка
-- стенда и ввести КЛЮЧ, но не адрес. В итоге у одного человека всё работает, а у
-- остальных — нет, и причину они не видят.
--
-- Что здесь лежит:
--   title    — как человек называет свой сервер («llama.cpp дома»);
--   base_url — адрес OpenAI-совместимого API, как его видит СЕРВЕР (не браузер):
--              у контейнера свой localhost, поэтому 127.0.0.1 указывать бессмысленно;
--   local    — считает ли сервер на машине человека (или в своей сети). Это решение
--              принимает человек, и оно определяет, нужно ли согласие на отправку текста:
--              llama.cpp в соседней комнате и чужой шлюз в интернете выглядят одинаково;
--   key_ciphertext — ключ, если сервер его требует. Шифруется тем же AI_SECRET_KEY,
--              что и ключи провайдеров: открытым текстом ключи не лежат.
CREATE TABLE IF NOT EXISTS ai_user_endpoints (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title          text        NOT NULL,
    base_url       text        NOT NULL,
    local          boolean     NOT NULL DEFAULT true,
    key_ciphertext bytea,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Свои серверы всегда читаются «для этого человека»: индекс по владельцу.
CREATE INDEX IF NOT EXISTS ai_user_endpoints_user_idx ON ai_user_endpoints(user_id);
