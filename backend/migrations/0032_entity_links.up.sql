-- 0032: связи между карточками мира — «Аня живёт на Земле».
--
-- Зачем отдельная таблица, а не поле в карточке. Связь — это пара карточек и подпись, и её
-- свойства (направление, подпись, уникальность, каскад при удалении) живут на уровне пары.
-- Хранить её в JSON внутри карточки значило бы держать две копии одной связи (у Ани и у Земли)
-- и следить, чтобы они не разошлись.
--
-- Направление важно: «Аня живёт на Земле» и «Земля живёт на Ане» — разные утверждения, и
-- подпись принадлежит связи, а не карточке. Обратную сторону интерфейс покажет сам
-- («на этой карточке: Аня — живёт на»), переворачивать подпись автоматически нельзя: из
-- «живёт на» не следует «место жительства Ани».
CREATE TABLE IF NOT EXISTS project_entity_links (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- Оба конца — карточки ОДНОГО проекта; это проверяет сервис, а каскад держит БД.
    from_entity uuid        NOT NULL REFERENCES project_entities(id) ON DELETE CASCADE,
    to_entity   uuid        NOT NULL REFERENCES project_entities(id) ON DELETE CASCADE,
    -- Подпись даёт человек: «живёт на», «знает», «сестра». Короткая: она печатается на ребре
    -- графа и рядом с чипом.
    label       text        NOT NULL,
    created_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT project_entity_links_no_self CHECK (from_entity <> to_entity),
    CONSTRAINT project_entity_links_label_len CHECK (char_length(label) BETWEEN 1 AND 40)
);

-- Одна и та же связь дважды не нужна; регистр подписи не различаем («живёт на» и «Живёт на»).
CREATE UNIQUE INDEX IF NOT EXISTS project_entity_links_uniq_idx
    ON project_entity_links (from_entity, to_entity, lower(label));

-- Обход в обе стороны: «что связано с этой карточкой» — это два запроса по одному индексу.
CREATE INDEX IF NOT EXISTS project_entity_links_from_idx ON project_entity_links (from_entity);
CREATE INDEX IF NOT EXISTS project_entity_links_to_idx ON project_entity_links (to_entity);
CREATE INDEX IF NOT EXISTS project_entity_links_project_idx ON project_entity_links (project_id);
