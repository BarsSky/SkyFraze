-- 0045: знания проекта (0.149.0) — то, что остаётся от беседы после её удаления.
--
-- Зачем отдельная таблица, а не «флаг на беседе». Беседа — личные заметки одного
-- человека: её нельзя показать соавтору и нельзя приложить к вопросу. Знание — наоборот,
-- содержимое ПРОЕКТА: его читают все участники, его прикладывают к сообщению, и оно
-- переживает и беседу, из которой выросло, и автоочистку истории. Поэтому у знания свой
-- `project_id` и своя жизнь; беседа лишь указывает, откуда оно взялось.
--
-- `author_name` — снимок имени, как в общем чате: через полгода знание должно отвечать
-- «кто это сформулировал», даже если человека уже нет в проекте.
--
-- `summary` — одна-две строки для списка: по ним человек ориентируется среди знаний, не
-- открывая каждое. Это отдельное поле, а не первые 200 знаков тела: тело начинается с
-- тезисов, а не с объяснения, о чём они.
CREATE TABLE IF NOT EXISTS ai_knowledge (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  author_name            text NOT NULL DEFAULT '',
  title                  text NOT NULL,
  summary                text NOT NULL DEFAULT '',
  body                   text NOT NULL,
  chars                  integer NOT NULL DEFAULT 0,
  source_conversation_id uuid REFERENCES ai_conversations(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_knowledge_project_idx
  ON ai_knowledge (project_id, created_at DESC);

-- Срок хранения бесед: 0 — не удалять (умолчание). Живёт в настройках агента проекта,
-- потому что это решение владельца истории, а не личная настройка каждого читателя:
-- беседы соавторов по одному проекту стареют вместе.
ALTER TABLE project_ai_settings
  ADD COLUMN IF NOT EXISTS retention_days integer NOT NULL DEFAULT 0;

-- «Не удалять эту беседу» — отдельный флаг, а не «превратить в знание»: человек может
-- хотеть сохранить саму переписку (черновики, отказы модели), а не только выводы.
ALTER TABLE ai_conversations
  ADD COLUMN IF NOT EXISTS kept boolean NOT NULL DEFAULT false;

-- Вложения к реплике: [{"id": "...", "title": "..."}]. Заголовок — снимок, как у кадра:
-- знание могут переименовать или удалить, а сообщение должно остаться читаемым.
ALTER TABLE ai_messages
  ADD COLUMN IF NOT EXISTS knowledge jsonb NOT NULL DEFAULT '[]'::jsonb;

-- То же для общего чата проекта: знание можно приложить к вопросу Нестору, чтобы он
-- отвечал по сохранённым выводам, а не по памяти беседы, которой у бота нет.
ALTER TABLE project_chat_messages
  ADD COLUMN IF NOT EXISTS knowledge jsonb NOT NULL DEFAULT '[]'::jsonb;
