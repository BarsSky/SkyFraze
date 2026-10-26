-- 0027: предложение правки ФРАГМЕНТА текста (правка ассистента по замечанию).
--
-- Зачем отдельные поля, а не переиспользовать old_body/new_body. Предложение правки кадра
-- описывает «было/станет» целиком; предложение фрагмента — «этот кусок заменить вот на это».
-- Смешать их в одних колонках значило бы потерять главное: при применении надо сверить
-- именно фрагмент, а не весь кадр, иначе чужая правка в соседнем абзаце отменяла бы
-- законное предложение.
--
-- Якоря копируются в предложение, а не берутся из комментария при применении: комментарий
-- могли удалить или связать с другим местом, а предложение должно оставаться проверяемым.
-- `old_span` — текст фрагмента в момент предложения: по нему проверяется «фрагмент не
-- изменился» (то же правило, что у правки кадра, только на уровень ниже).
ALTER TABLE ai_changes
    ADD COLUMN IF NOT EXISTS comment_id uuid REFERENCES event_comments(id) ON DELETE SET NULL;

ALTER TABLE ai_changes
    ADD COLUMN IF NOT EXISTS anchor_start bytea;

ALTER TABLE ai_changes
    ADD COLUMN IF NOT EXISTS anchor_end bytea;

ALTER TABLE ai_changes
    ADD COLUMN IF NOT EXISTS old_span text NOT NULL DEFAULT '';

ALTER TABLE ai_changes
    ADD COLUMN IF NOT EXISTS new_span text NOT NULL DEFAULT '';
