-- 0038_project_chat.up.sql — общий чат проекта (0.95.0).
--
-- Зачем. Обсуждение в проекте было возможно только замечаниями к кадру: они привязаны к фрагменту
-- текста и живут в блоке кадра. Для «обсудить идею, спросить коллегу, позвать Нестора на разбор»
-- это не то место — замечание к кадру без кадра не поставить, а разговор участников должен быть
-- один на проект.
--
-- Что здесь:
--   * kind: 'user' — написал участник, 'bot' — ответ Нестора (искусственный автор);
--   * author_name — подпись на момент сообщения: имя участника или имя бота. Автор может быть
--     удалён (author_id станет null), а разговор должен остаться читаемым;
--   * ссылка на элемент текста — кадр и (необязательно) точная цитата из него. Якоря
--     (Y.RelativePosition) здесь не нужны: сообщение в чате — не замечание, и «показать в тексте»
--     делается клиентом по цитате (переживёт правки текста без специальной поддержки);
--   * ON DELETE: сообщения живут с проектом и кадром. Кадр удалили — сообщение остаётся, но
--     ссылка становится пустой (SET NULL): потерять весь разговор из-за одного кадра нельзя.
CREATE TABLE IF NOT EXISTS project_chat_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  author_name text NOT NULL,
  kind        text NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'bot')),
  body        text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000),
  event_id    uuid REFERENCES events(id) ON DELETE SET NULL,
  quote       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Чтение — «все сообщения проекта по порядку» и «что нового после последнего прочитанного»:
-- оба запроса идут по этому индексу.
CREATE INDEX IF NOT EXISTS project_chat_messages_project_idx
  ON project_chat_messages (project_id, created_at, id);
