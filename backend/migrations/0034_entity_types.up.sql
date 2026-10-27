-- 0034: свои типы карточек (docs/entity-types.md, фаза 1).
--
-- Зачем. Вид карточки был жёстко зашит: `kind IN ('character','place','theme')`. Для книги про
-- фракции, артефакты или корабли это тесно, и человек либо пихал всё в «тему», либо заводил
-- отдельный проект. Теперь типы живут в проекте: три стартовых остаются по умолчанию, свои
-- добавляются и переименовываются.
--
-- Почему `key` и `title` — разные поля. `key` машинный (латиница): на него ссылаются карточки,
-- экспорт и помощник, и меняться он не должен никогда. `title` — то, что видит человек
-- («Фракция»), переименование безопасно.
--
-- Почему типы в проекте, а не глобально. «Фракция» в одном романе и в чужом проекте — разные
-- вещи; глобальные типы означали бы отдельный контур прав и миграции (см. §4 таблицы решений).
CREATE TABLE IF NOT EXISTS project_entity_types (
    project_id  uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- Машинное имя: строчная латиница, цифры, дефис и подчёркивание. 1–32 знака.
    key         text        NOT NULL,
    -- Название для человека: «Персонаж», «Фракция». 1–40 знаков.
    title       text        NOT NULL,
    -- Цвет и значок по умолчанию для новых карточек этого типа (необязательно).
    color       text        NOT NULL DEFAULT '',
    icon        text        NOT NULL DEFAULT '',
    position    int         NOT NULL DEFAULT 0,
    -- Стартовые типы нельзя удалить (только переименовать): карточки на них рассчитывают.
    is_default  boolean     NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, key),
    CONSTRAINT project_entity_types_key_format CHECK (key ~ '^[a-z][a-z0-9_-]{0,31}$'),
    CONSTRAINT project_entity_types_title_len CHECK (char_length(title) BETWEEN 1 AND 40),
    CONSTRAINT project_entity_types_icon_len CHECK (char_length(icon) <= 8)
);

-- Стартовые типы — каждому существующему проекту. Идемпотентно: повторная миграция ничего не
-- меняет, а переименованный человеком «Персонаж» не перетирается.
INSERT INTO project_entity_types (project_id, key, title, position, is_default)
SELECT p.id, t.key, t.title, t.position, true
FROM projects p
CROSS JOIN (
    VALUES ('character', 'Персонаж', 0), ('place', 'Место', 1), ('theme', 'Тема', 2)
) AS t(key, title, position)
ON CONFLICT (project_id, key) DO NOTHING;

-- CHECK на три значения снимаем: теперь вид проверяется наличием типа в проекте.
ALTER TABLE project_entities DROP CONSTRAINT IF EXISTS project_entities_kind_check;

-- Вид карточки обязан существовать в проекте. RESTRICT — не каскад: удаление типа с карточками
-- потеряло бы классификацию молча, а сервис отвечает человеку списком этих карточек.
DO $$
BEGIN
    ALTER TABLE project_entities
        ADD CONSTRAINT project_entities_kind_fk
        FOREIGN KEY (project_id, kind)
        REFERENCES project_entity_types (project_id, key)
        ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Порядок типов в списках: стартовые первыми, дальше как завёл человек.
CREATE INDEX IF NOT EXISTS project_entity_types_order_idx
    ON project_entity_types (project_id, is_default DESC, position, lower(title));
