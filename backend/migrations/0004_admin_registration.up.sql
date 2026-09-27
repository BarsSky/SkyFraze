-- 0004: администрирование и режим регистрации.
--
-- Задача: при развёртывании администратор определяет, может ли регистрироваться
-- кто угодно или только по заявке. По умолчанию — по заявке: открытая регистрация
-- это осознанное решение, а не поведение «из коробки».
--
-- Что появляется:
--   * users.is_admin — признак администратора (назначается env ADMIN_EMAILS
--     при старте, а если админов нет вообще — первый зарегистрированный);
--   * app_settings — изменяемые настройки приложения (ключ/значение);
--     registration_mode: 'request' (по заявке, дефолт) | 'open' (свободная);
--   * registration_requests — заявки на регистрацию: пароль хранится сразу
--     хэшем, поэтому одобрение создаёт готовый аккаунт без почтовых ссылок.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO app_settings (key, value)
VALUES ('registration_mode', 'request')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS registration_requests (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    message       TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected')),
    note          TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at    TIMESTAMPTZ,
    decided_by    UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Одна активная заявка на email: повторная отправка не должна плодить дубли,
-- а одобренная/отклонённая заявка не мешает подать новую.
CREATE UNIQUE INDEX IF NOT EXISTS registration_requests_pending_email
    ON registration_requests (lower(email)) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS registration_requests_status_idx
    ON registration_requests (status, created_at DESC);
