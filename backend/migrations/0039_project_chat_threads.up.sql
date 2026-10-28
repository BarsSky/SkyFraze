-- 0039_project_chat_threads.up.sql — ответы на сообщение и правка своего (0.96.0).
--
-- reply_to — «это ответ на сообщение». Дерево разговоров не строим: в ленте проекта ветки
-- превращаются в лесенку и читаются хуже, чем одна лента с цитатой-ссылкой на исходное.
-- ON DELETE SET NULL: удалённое сообщение не уносит ответы (удаления в этой версии ещё нет, но
-- правило хранения важнее текущего набора ручек).
--
-- edited_at — «изменено после отправки». Время, а не флаг: по нему видно, правили ли сообщение
-- до ответа на него, и это честная информация, а не украшение.
ALTER TABLE project_chat_messages
  ADD COLUMN IF NOT EXISTS reply_to uuid REFERENCES project_chat_messages(id) ON DELETE SET NULL;

ALTER TABLE project_chat_messages
  ADD COLUMN IF NOT EXISTS edited_at timestamptz;
