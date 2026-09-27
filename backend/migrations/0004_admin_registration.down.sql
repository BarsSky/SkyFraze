-- 0004 down: убираем администрирование и заявки на регистрацию.
DROP TABLE IF EXISTS registration_requests;
DROP TABLE IF EXISTS app_settings;
ALTER TABLE users DROP COLUMN IF EXISTS is_admin;
