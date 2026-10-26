-- 0028 down: убрать ключи доступа и состояние церемоний.
--
-- Ключи удаляются целиком: приватная часть живёт в аутентификаторе, и без строки в базе она
-- бесполезна. У людей, у которых включён второй фактор, остаётся TOTP и коды восстановления —
-- снаружи они не запираются.
DROP INDEX IF EXISTS webauthn_challenges_expiry_idx;
DROP TABLE IF EXISTS webauthn_challenges;
DROP INDEX IF EXISTS user_webauthn_user_idx;
DROP TABLE IF EXISTS user_webauthn_credentials;
