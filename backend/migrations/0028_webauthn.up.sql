-- 0028: ключи доступа (WebAuthn) — второй фактор кроме TOTP.
--
-- Зачем. TOTP работает везде, но требует приложения и ввода шести цифр; ключ доступа — это
-- отпечаток или Face ID одним касанием. И у него есть свойство, которого у TOTP нет: ключ
-- нельзя продиктовать по телефону, а подпись привязана к домену.
--
-- Домен и TLS уже есть (docs/webauthn.md §1): origin https://fraze.skynas.ru, сертификат
-- Let's Encrypt. RP ID — fraze.skynas.ru, и это решение необратимо: ключ, созданный для этого
-- домена, не действует для других сервисов (и наоборот) — см. §2 документа.
--
-- Что здесь НЕ хранится: приватный ключ. Сервер видит только публичный — поэтому утечка базы
-- не даёт войти под человеком (в отличие от пароля и секрета TOTP).
CREATE TABLE IF NOT EXISTS user_webauthn_credentials (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- id ключа, который выдал аутентификатор. UNIQUE: один ключ живёт ровно у одного человека.
    credential_id bytea       NOT NULL UNIQUE,
    -- COSE-ключ для проверки подписи.
    public_key    bytea       NOT NULL,
    -- Счётчик подписей: рост от входа к входу говорит «это тот же ключ». Не блокирует вход:
    -- часть платформенных аутентификаторов всегда отдаёт ноль (docs/webauthn.md §5).
    sign_count    bigint      NOT NULL DEFAULT 0,
    transports    text        NOT NULL DEFAULT '',
    aaguid        text        NOT NULL DEFAULT '',
    -- Имя даёт человек: «ноутбук», «телефон» — иначе список ключей это список байтов.
    name          text        NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz
);

CREATE INDEX IF NOT EXISTS user_webauthn_user_idx
    ON user_webauthn_credentials(user_id, created_at DESC);

-- Состояние церемонии (challenge и сессия go-webauthn) на время одного шага.
--
-- Почему в базе, а не в памяти процесса: сервер перезапускается (обновление стенда), а
-- человек в этот момент как раз подтверждает ключ. «Попробуйте ещё раз» после перезапуска —
-- хуже, чем строка в таблице, которая живёт минуты.
--
-- challenge одноразовый: удаляется при любом исходе (успех, отказ, истечение) — это и есть
-- защита от повторного использования перехваченного ответа.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid        REFERENCES users(id) ON DELETE CASCADE,
    kind       text        NOT NULL,
    challenge  bytea       NOT NULL,
    session    jsonb       NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CONSTRAINT webauthn_challenges_kind_check CHECK (kind IN ('register', 'login'))
);

CREATE INDEX IF NOT EXISTS webauthn_challenges_expiry_idx
    ON webauthn_challenges(expires_at);
