-- 0003: публичная лента — публикация проекта, просмотры и оценки.
--
-- Правила:
--   * публичным становится ТОЛЬКО проект, который владелец явно опубликовал
--     (projects.is_public = true); по умолчанию всё закрыто;
--   * public_slug — постоянная ссылка вида /s/{slug}; генерируется при первой
--     публикации и сохраняется при снятии с публикации, чтобы ссылка не менялась;
--   * просмотры дедуплицируются: один посетитель — один просмотр проекта в сутки
--     (уникальный индекс project_views_dedupe). projects.views_count — счётчик для
--     сортировки ленты, инкрементируется только при вставке новой строки;
--   * оценки: одна оценка на пользователя на проект (PK project_id+user_id),
--     звёзды 1..5. Среднее и количество считаются на чтение (без денормализации),
--     поэтому расхождений с фактическими голосами быть не может.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_public    BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS public_slug  TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS views_count  INTEGER NOT NULL DEFAULT 0;

-- Ссылка уникальна, но NULL у неопубликованных проектов допустим.
CREATE UNIQUE INDEX IF NOT EXISTS projects_public_slug_key
    ON projects (public_slug) WHERE public_slug IS NOT NULL;

-- Лента: «сначала новые» — основной порядок, частичный индекс только по публичным.
CREATE INDEX IF NOT EXISTS projects_public_feed_idx
    ON projects (published_at DESC NULLS LAST) WHERE is_public;

-- ---------- просмотры ----------
CREATE TABLE IF NOT EXISTS project_views (
    id          BIGSERIAL PRIMARY KEY,
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    visitor_key TEXT NOT NULL,
    viewed_on   DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS project_views_dedupe
    ON project_views (project_id, visitor_key, viewed_on);

CREATE INDEX IF NOT EXISTS project_views_project_idx ON project_views (project_id);

-- ---------- оценки ----------
CREATE TABLE IF NOT EXISTS project_ratings (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stars      SMALLINT NOT NULL CHECK (stars >= 1 AND stars <= 5),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS project_ratings_project_idx ON project_ratings (project_id);
