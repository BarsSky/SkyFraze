-- Откат 0006: каталог людей.
DROP INDEX IF EXISTS idx_users_crafts_gin;
ALTER TABLE users DROP COLUMN IF EXISTS discoverable;
ALTER TABLE users DROP COLUMN IF EXISTS crafts;
ALTER TABLE users DROP COLUMN IF EXISTS bio;
