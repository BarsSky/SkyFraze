-- 0027 down: убрать поля правки фрагмента. Применённые правки фрагмента после отката
-- перестают быть отменяемыми («Вернуть» не знает, какой кусок менять), сами тексты кадров
-- не трогаются.
ALTER TABLE ai_changes DROP COLUMN IF EXISTS new_span;
ALTER TABLE ai_changes DROP COLUMN IF EXISTS old_span;
ALTER TABLE ai_changes DROP COLUMN IF EXISTS anchor_end;
ALTER TABLE ai_changes DROP COLUMN IF EXISTS anchor_start;
ALTER TABLE ai_changes DROP COLUMN IF EXISTS comment_id;
