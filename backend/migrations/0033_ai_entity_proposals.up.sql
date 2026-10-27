-- 0033: предложения помощника «заведите вот такие карточки мира и связи между ними».
--
-- Зачем не сразу создавать. Карточка — не правка одной сцены: она меняет весь проект (упоминания
-- в тексте, хронологию, матрицу, граф связей), а неверная карточка портит связи везде, где
-- встречается это имя. Поэтому помощник предлагает, а создаёт человек — так же, как с правкой
-- кадра (миграция 0015), но другой путь: карточки живут в Postgres, а не в документе CRDT, и
-- «применить» здесь значит вставить строки, а не переписать текст.
--
-- Почему отдельная таблица, а не `ai_changes`. У `ai_changes` обязателен `event_id`: предложение
-- всегда про ОДИН кадр. Здесь кадров нет вовсе — есть пачка карточек и связей, и общих колонок
-- с правкой текста не остаётся ни одной, кроме статуса. Смешать их значило бы держать половину
-- колонок пустыми и объяснять каждому читателю, какие из них к чему.
--
-- links хранятся ИМЕНАМИ карточек, а не идентификаторами: на момент предложения карточек ещё
-- нет. При применении имена разрешаются в id — те, что уже есть в проекте, находятся, остальные
-- создаются из этой же пачки.
CREATE TABLE IF NOT EXISTS ai_entity_proposals (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id uuid        REFERENCES ai_conversations(id) ON DELETE SET NULL,
    -- Чьими правами предложено и кто может применить: беседа личная, как и с правкой кадра.
    user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Почему помощник это предлагает — одной строкой, человеческими словами.
    note            text        NOT NULL DEFAULT '',
    -- [{kind, name, aliases: [..], description}] — в том порядке, в каком их видит человек.
    cards           jsonb       NOT NULL DEFAULT '[]'::jsonb,
    -- [{from, to, label}] — именами; см. выше, почему не id.
    links           jsonb       NOT NULL DEFAULT '[]'::jsonb,
    -- pending | applied | discarded. Отмены («вернуть») нет намеренно: созданная карточка
    -- удаляется одной кнопкой в панели связей, и притворяться, что для этого нужен снимок,
    -- было бы лишним механизмом.
    status          text        NOT NULL DEFAULT 'pending',
    created_at      timestamptz NOT NULL DEFAULT now(),
    applied_at      timestamptz
);

-- Ожидающие читаются списком «для проекта и человека»; решённые — по идентификатору.
CREATE INDEX IF NOT EXISTS ai_entity_proposals_pending_idx
    ON ai_entity_proposals(project_id, user_id, created_at DESC)
    WHERE status = 'pending';
