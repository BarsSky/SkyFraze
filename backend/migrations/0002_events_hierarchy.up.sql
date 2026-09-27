-- 0002: серверная модель иерархии событий + отдельное хранилище CRDT-снапшота.
--
-- До этой миграции иерархия существовала только внутри Yjs-блоба (parent_id в
-- Y.Map), а таблица events использовалась как «контейнер» одного снапшота на
-- проект (строка-заглушка с пустыми title/body). Теперь:
--   * events  — по строке на событие: parent_id/depth/position + тексты;
--   * project_event_state — непрозрачный CRDT-снапшот с ревизией для
--     оптимистичной блокировки (base revision → 409 при расхождении).

-- ---------- events: иерархия ----------
ALTER TABLE events ADD COLUMN IF NOT EXISTS parent_id  UUID;
ALTER TABLE events ADD COLUMN IF NOT EXISTS depth      SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id);

-- Самоссылочный FK с каскадом: удаление главы удаляет её под-события силами БД.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_parent_id_fkey') THEN
        ALTER TABLE events
            ADD CONSTRAINT events_parent_id_fkey
            FOREIGN KEY (parent_id) REFERENCES events(id) ON DELETE CASCADE;
    END IF;
END $$;

-- CHECK-и добавляются NOT VALID, чтобы не падать на уже существующих строках,
-- если в БД остались аномалии: новые/изменённые строки проверяются всегда.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_no_self_parent') THEN
        ALTER TABLE events
            ADD CONSTRAINT events_no_self_parent
            CHECK (parent_id IS NULL OR parent_id <> id) NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_depth_range') THEN
        ALTER TABLE events
            ADD CONSTRAINT events_depth_range
            CHECK (depth >= 0 AND depth <= 8) NOT VALID;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_position_nonneg') THEN
        ALTER TABLE events
            ADD CONSTRAINT events_position_nonneg
            CHECK (position >= 0) NOT VALID;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_events_parent_position ON events (project_id, parent_id, position);
CREATE INDEX IF NOT EXISTS idx_events_project_depth   ON events (project_id, depth);

-- ---------- CRDT-снапшот проекта ----------
CREATE TABLE IF NOT EXISTS project_event_state (
    project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    yjs_state  BYTEA NOT NULL,
    revision   BIGINT NOT NULL DEFAULT 1,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Переносим последний непустой снапшот из legacy-строк events.
INSERT INTO project_event_state (project_id, yjs_state, revision, updated_by, updated_at)
SELECT DISTINCT ON (project_id) project_id, yjs_state, 1, created_by, updated_at
  FROM events
 WHERE yjs_state IS NOT NULL AND length(yjs_state) > 0
 ORDER BY project_id, updated_at DESC
ON CONFLICT (project_id) DO NOTHING;

-- Строки-заглушки снапшота больше не нужны (ровно они и были «фантомными
-- событиями» в GET /events): признак — непустой yjs_state при пустых title/body.
DELETE FROM events
 WHERE yjs_state IS NOT NULL AND title = '' AND body = '' AND parent_id IS NULL;

ALTER TABLE events DROP COLUMN IF EXISTS yjs_state;
