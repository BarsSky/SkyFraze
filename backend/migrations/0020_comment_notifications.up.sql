-- 0020: уведомления о новых замечаниях — согласие человека и очередь отправки.
--
-- Зачем очередь, а не «отправить письмо в момент комментария». Отправка письма — это сеть и
-- чужой сервер: он может быть недоступен, ответить 4xx или подвиснуть. Держать из-за этого
-- HTTP-запрос автора комментария (или ронять сам комментарий, уже записанный) — неправильно.
-- Поэтому комментарий пишется сразу, а письмо уходит фоновым обходом из этой таблицы:
-- сбои повторяются, а «письмо не ушло» не отменяет замечание.
--
-- Согласие — галочка в профиле (users.notify_comments), по умолчанию ВЫКЛЮЧЕНА. Причина не
-- в осторожности: текст проекта — личное, и отправлять его на чужой почтовый сервер можно
-- только осознанно (та же логика, что у согласия на отправку текста модели, docs/ai-assistant.md).
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_comments boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS comment_notifications (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    event_id   uuid        NOT NULL,
    -- Удалили комментарий — уведомление о нём не нужно: каскад.
    comment_id uuid        NOT NULL REFERENCES event_comments(id) ON DELETE CASCADE,
    -- Кому: автор комментария сюда не попадает (он и так знает).
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at    timestamptz,
    -- Попытки и последняя ошибка: видно, почему письмо не ушло, и когда перестать пытаться.
    attempts   int         NOT NULL DEFAULT 0,
    last_error text        NOT NULL DEFAULT ''
);

-- Обход очереди: «что ещё не отправлено». Частичный индекс — ровно под этот запрос.
CREATE INDEX IF NOT EXISTS comment_notifications_pending_idx
    ON comment_notifications(created_at)
    WHERE sent_at IS NULL;
