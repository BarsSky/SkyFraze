-- Откат 0005: соавторы и ники.
DROP TABLE IF EXISTS coauthor_links;
DROP INDEX IF EXISTS idx_users_username_lower;
ALTER TABLE users DROP COLUMN IF EXISTS username;
