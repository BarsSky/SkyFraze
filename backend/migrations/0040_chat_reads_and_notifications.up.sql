-- 0040_chat_reads_and_notifications.up.sql — прочитанное в чате и письма о нём (0.97.0).
--
-- Зачем серверное «прочитано». До 0.97.0 отметка «последнее прочитанное» жила в localStorage: она
-- работала для маркера в окне, но не могла ответить колокольчику «где меня ждут» — тот считает по
-- серверу и про другой браузер ничего не знает. Чат — один на проект, поэтому отметка проектная.
--
-- Письма — та же схема, что у замечаний (0020): очередь, фоновая отправка, повторы и
-- last_error. Держать HTTP-запрос автора из-за чужого почтового сервера нельзя.
CREATE TABLE IF NOT EXISTS project_chat_reads (
    project_id uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seen_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS chat_notifications (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- Удалили сообщение — уведомление о нём не нужно: каскад.
    message_id uuid        NOT NULL REFERENCES project_chat_messages(id) ON DELETE CASCADE,
    -- Кому: автор сообщения сюда не попадает (он и так знает).
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at    timestamptz,
    attempts   int         NOT NULL DEFAULT 0,
    last_error text        NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS chat_notifications_pending_idx
    ON chat_notifications(created_at)
    WHERE sent_at IS NULL;

-- «Сколько нового в моих проектах» — по этому индексу.
CREATE INDEX IF NOT EXISTS project_chat_messages_project_created_idx
    ON project_chat_messages (project_id, created_at);
