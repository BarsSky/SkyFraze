-- 0003 down: убираем публичную ленту (оценки, просмотры, признаки публикации).
DROP TABLE IF EXISTS project_ratings;
DROP TABLE IF EXISTS project_views;
DROP INDEX IF EXISTS projects_public_feed_idx;
DROP INDEX IF EXISTS projects_public_slug_key;
ALTER TABLE projects DROP COLUMN IF EXISTS views_count;
ALTER TABLE projects DROP COLUMN IF EXISTS published_at;
ALTER TABLE projects DROP COLUMN IF EXISTS public_slug;
ALTER TABLE projects DROP COLUMN IF EXISTS is_public;
