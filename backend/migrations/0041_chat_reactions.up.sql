-- 0041: отметки на сообщениях чата — «согласен», «надо сделать», «вопрос».
--
-- Зачем отдельная таблица, а не поле в сообщении. Отметка — это пара «сообщение × человек × вид»,
-- и её свойства (уникальность, снятие повторным нажатием, каскад при удалении) живут на уровне
-- пары. JSON внутри сообщения держал бы N копий одного факта и требовал бы «переписать всех» при
-- одном нажатии.
--
-- Набор видов фиксирован CHECK, как у реакций на замечания (0025): это рабочие отметки о тексте
-- проекта, а не «любой эмодзи». Свободная палитра превратила бы обсуждение в рейтинг, а
-- «полезность» сообщения нельзя посчитать осмысленно.
CREATE TABLE IF NOT EXISTS project_chat_reactions (
    message_id uuid        NOT NULL REFERENCES project_chat_messages(id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, kind),
    CONSTRAINT project_chat_reactions_kind_check CHECK (kind IN ('agree', 'todo', 'question'))
);

-- Лента читает отметки пачкой по своим сообщениям: без индекса это seq scan на каждое открытие
-- окна чата, а таблица растёт вместе с историей.
CREATE INDEX IF NOT EXISTS project_chat_reactions_message_idx
    ON project_chat_reactions (message_id);
