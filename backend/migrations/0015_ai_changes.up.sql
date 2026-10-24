-- 0015: предложенные агентом правки существующих кадров.
--
-- Зачем отдельная таблица, а не «применить сразу». До этой миграции помощник умел только
-- СОЗДАВАТЬ кадры: удалять и переписывать он не мог намеренно (docs/ai-assistant.md,
-- «Что не берём»). Причина не в лени: «перепиши вторую главу» и «удали лишнее» —
-- необратимые правки чужого текста, и модель, которая делает их сама, рано или поздно
-- сделает не то, а отменить это будет нечем.
--
-- Поэтому правка приходит ПРЕДЛОЖЕНИЕМ: агент описывает, что хочет изменить, сервер
-- сохраняет снимок текущего текста и предлагаемый, а применяет это человек — одной
-- кнопкой в том же окне. Отсюда и поля:
--
--   kind          — что предлагается: update_text (заголовок и/или текст) | delete_event;
--   event_id/title — к какому кадру (title на момент предложения: подпись в интерфейсе);
--   old_title/old_body — снимок ДО: по нему показывается «было» и работает «Вернуть»,
--                   а ещё им проверяется, что кадр не изменился с момента предложения;
--   new_title/new_body — предлагаемое содержимое (для удаления пусто);
--   status        — pending | applied | discarded | superseded;
--   applied_at    — когда применили (пусто, пока не применили).
CREATE TABLE IF NOT EXISTS ai_changes (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id uuid        REFERENCES ai_conversations(id) ON DELETE SET NULL,
    -- Чьими правами предложено и кто может применить: беседа личная, и правку
    -- подтверждает тот, кто её заказал.
    user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind            text        NOT NULL,
    event_id        uuid        NOT NULL,
    event_title     text        NOT NULL DEFAULT '',
    old_title       text        NOT NULL DEFAULT '',
    old_body        text        NOT NULL DEFAULT '',
    new_title       text        NOT NULL DEFAULT '',
    new_body        text        NOT NULL DEFAULT '',
    status          text        NOT NULL DEFAULT 'pending',
    created_at      timestamptz NOT NULL DEFAULT now(),
    applied_at      timestamptz
);

-- Ожидающие предложения читаются списком «для проекта и человека»; применённые — по
-- одному идентификатору (первичный ключ).
CREATE INDEX IF NOT EXISTS ai_changes_pending_idx
    ON ai_changes(project_id, user_id, created_at DESC)
    WHERE status = 'pending';
