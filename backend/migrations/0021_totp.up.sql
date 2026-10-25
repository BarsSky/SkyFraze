-- 0021: двухфакторный вход (TOTP) и коды восстановления.
--
-- Зачем. Пароль — единственный фактор входа (docs/security.md §3), и лимит попыток его не
-- заменяет: утёкший пароль открывает аккаунт сразу. TOTP — второй фактор, который считается
-- на телефоне человека без внешних сервисов, писем и SMS: ничего настраивать на стенде не
-- нужно, поэтому это можно включить и проверить без чужого SMTP.
--
-- Почему отдельная таблица, а не колонки в users. Секрет нужен ТОЛЬКО при входе и при
-- включении/выключении; в обычных запросах пользователя он не нужен вовсе. Отдельная строка
-- позволяет выдавать секрет (pending) до включения и не трогать самый горячий SELECT.
CREATE TABLE IF NOT EXISTS user_totp (
    user_id    uuid        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- base32 без паддинга, как его ждут приложения-аутентификаторы.
    secret     text        NOT NULL,
    -- NULL — секрет выдан, но вход по нему ещё не проверяли (включение не завершено).
    enabled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Коды восстановления: одноразовые, хранятся хешами.
--
-- Зачем хеши. Код восстановления — это второй пароль. Если базу читают, открытые коды дадут
-- вход в аккаунт в обход телефона; хеш делает их бесполезными для чтения, но годными для
-- сверки. SHA-256 без соли здесь достаточен: код случайный и длинный, перебирать его по
-- хешу дороже, чем просто подобрать пароль.
CREATE TABLE IF NOT EXISTS user_recovery_codes (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  text        NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_recovery_codes_user_idx
    ON user_recovery_codes(user_id) WHERE used_at IS NULL;
