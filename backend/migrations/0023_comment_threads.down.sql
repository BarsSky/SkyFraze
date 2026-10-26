-- 0023 down: убрать ветки и мягкое удаление комментария.
--
-- ВНИМАНИЕ: откат необратим для удалённого. Строки, помеченные `deleted_at`, содержат
-- пустое тело — восстановить текст откатом нельзя. Перед откатом стоит снять копию базы.
DROP INDEX IF EXISTS event_comments_live_idx;
DROP INDEX IF EXISTS event_comments_parent_idx;
ALTER TABLE event_comments DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE event_comments DROP COLUMN IF EXISTS parent_id;
