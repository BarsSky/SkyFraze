-- 0018: комментарии к кадрам.
--
-- Зачем отдельная таблица, а не поле в кадре. Кадр живёт в CRDT-документе, и всё, что в
-- нём лежит, — это ТЕКСТ проекта: он уезжает в книгу, в Markdown-выгрузку и в ленту.
-- Обсуждение («тут герой не мог знать про маяк») — не текст истории, и смешивать их
-- значит портить выгрузку и путать читателя с автором.
--
-- Почему нет внешнего ключа на events. Проекция дерева перестраивается целиком
-- (`store.ReplaceEventTree`: удалить-вставить), и FK с ON DELETE CASCADE стирал бы
-- комментарии при каждом пересчёте дерева — то есть при любой правке структуры. Поэтому
-- связь по значению event_id, а комментарии к исчезнувшим кадрам убирает уборщик
-- (maintenance, старше суток — как и осиротевшие файлы: свежая пропажа бывает серединой
-- импорта).
CREATE TABLE IF NOT EXISTS event_comments (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- Идентификатор кадра в документе (поле `id` события, не строка events.id).
    event_id   uuid        NOT NULL,
    -- Автор: удаление своего комментария и подпись «кто это написал».
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Лента обсуждения кадра — самый частый запрос: по кадру, по времени.
CREATE INDEX IF NOT EXISTS event_comments_event_idx
    ON event_comments(event_id, created_at);

-- Счётчики для дерева («у каких кадров есть обсуждение») и уборка по проекту.
CREATE INDEX IF NOT EXISTS event_comments_project_idx
    ON event_comments(project_id, created_at);
