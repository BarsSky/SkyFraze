-- 0029: аудит входов — кто, откуда и каким фактором входил (и чем пытался).
--
-- Зачем. Активные сеансы (0021) отвечают на вопрос «где я сейчас вошёл», но не на вопросы
-- «когда я входил последний раз», «с какого адреса пытались войти в мой аккаунт» и «входил ли
-- кто-то по коду восстановления». Код восстановления — единственный путь входа, который
-- человек мог потерять вместе с листком бумаги; его использование стоит замечать.
--
-- Приватность (решение, а не побочный эффект):
--   * строки пишутся ТОЛЬКО для существующих аккаунтов. Введённый адрес неизвестного
--     человека не сохраняется вовсе: показать его некому, а хранение чужих адресов —
--     это сбор персональных данных без цели;
--   * email не дублируется: есть user_id, этого достаточно (учётная запись живёт рядом);
--   * срок хранения ограничен 90 днями и выполняется тем же фоновым уборщиком, что и
--     корзина проектов (auth.LoginAuditRetention).
CREATE TABLE IF NOT EXISTS login_audit (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- outcome: ok | bad_password | bad_code | bad_key | locked | request_pending | request_rejected
    outcome    text        NOT NULL,
    -- factor: чем вошли — password | totp | recovery | passkey. Для неудач пусто.
    factor     text        NOT NULL DEFAULT '',
    ip         text        NOT NULL DEFAULT '',
    user_agent text        NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT login_audit_outcome_check CHECK (
        outcome IN ('ok', 'bad_password', 'bad_code', 'bad_key', 'locked',
                    'request_pending', 'request_rejected')
    ),
    CONSTRAINT login_audit_factor_check CHECK (
        factor IN ('', 'password', 'totp', 'recovery', 'passkey')
    )
);

-- Профиль читает «мои последние входы» — этот индекс и есть весь запрос.
CREATE INDEX IF NOT EXISTS login_audit_user_idx
    ON login_audit(user_id, created_at DESC);

-- Уборка по сроку хранения: без индекса она сканирует таблицу целиком.
CREATE INDEX IF NOT EXISTS login_audit_created_idx
    ON login_audit(created_at);
