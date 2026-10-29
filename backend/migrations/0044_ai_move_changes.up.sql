-- 0044: перенос кадра по дереву помощником (четвёртый вид предложения).
--
-- Зачем отдельные колонки, а не «правка текста с родителем». Перенос меняет МЕСТО кадра в
-- дереве, а не содержимое: «Вернуть» должно вернуть прежнего родителя и не трогать текст,
-- дату и вложения. Поэтому у вида `move_event` свой набор полей.
--
-- `old_parent_title`/`new_parent_title` — не дублирование ради удобства: интерфейс показывает
-- «место: Глава 1 → Глава 2», и если главу потом переименуют, человек, читая историю
-- предложения, должен видеть названия такими, какими они были в момент решения.
--
-- NULL в `old_parent_id` значит «корень» (глава верхнего уровня), а не «не задано»: перенос в
-- корень — законное действие, и отличать его от «поля нет» обязательно.
ALTER TABLE ai_changes
  ADD COLUMN IF NOT EXISTS old_parent_id uuid;

ALTER TABLE ai_changes
  ADD COLUMN IF NOT EXISTS new_parent_id uuid;

ALTER TABLE ai_changes
  ADD COLUMN IF NOT EXISTS old_parent_title text NOT NULL DEFAULT '';

ALTER TABLE ai_changes
  ADD COLUMN IF NOT EXISTS new_parent_title text NOT NULL DEFAULT '';
