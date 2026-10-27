-- 0030: карточки сущностей проекта — персонажи, места, темы (docs/entity-links.md).
--
-- Зачем. Кадры связаны общими персонажами и местами, но в модели проекта их не было: были
-- только заголовок, текст, дата и вложенные кадры. Связь «Анна появляется в этих кадрах»
-- держать негде, и она теряется.
--
-- Почему в Postgres, а не в CRDT-документе. Первая версия разбора предлагала хранить
-- карточки рядом с кадрами (в Yjs). При реализации это оказалось хуже по трём причинам:
--   * идентичность карточки — это УНИКАЛЬНОЕ имя в проекте, а CRDT уникальность не
--     обеспечивает: два человека одновременно создают «Анну» и получают двух «Анн», которые
--     потом надо сливать вручную;
--   * ближайший аналог в проекте — замечания к фрагментам (0026): метаданные О тексте, с
--     якорями, и они живут в Postgres, а не в документе;
--   * история версий снимает CRDT-снапшот текста; откат версии не должен воскрешать карточки,
--     которых человек уже удалил (та же логика, что у замечаний).
-- Упоминания (фаза 2) тоже лягут сюда: у них будут якоря, как у замечаний.
CREATE TABLE IF NOT EXISTS project_entities (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- character — персонаж, place — место, theme — тема (мотив, предмет, линия).
    kind        text        NOT NULL,
    name        text        NOT NULL,
    -- Алиасы: падежи и краткие формы («Аня», «Анны»). Морфологию не подключаем — словарь
    -- русского языка в этом месте даёт ложные связи, а список алиасов виден и правится.
    aliases     text[]      NOT NULL DEFAULT '{}',
    description text        NOT NULL DEFAULT '',
    -- Цвет подсветки в тексте (фаза 2). Пусто — берём по виду сущности.
    color       text        NOT NULL DEFAULT '',
    created_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT project_entities_kind_check CHECK (kind IN ('character', 'place', 'theme')),
    CONSTRAINT project_entities_name_len CHECK (char_length(name) BETWEEN 1 AND 80),
    CONSTRAINT project_entities_description_len CHECK (char_length(description) <= 600)
);

-- Идентичность: в одном проекте не может быть двух карточек с одинаковым именем без учёта
-- регистра. Без этого «Связи» показывали бы двух «Анн» и половину упоминаний каждой.
CREATE UNIQUE INDEX IF NOT EXISTS project_entities_name_idx
    ON project_entities (project_id, lower(name));

-- Список «Связей» — всегда «сущности проекта, сгруппированные по виду и имени».
CREATE INDEX IF NOT EXISTS project_entities_list_idx
    ON project_entities (project_id, kind, lower(name));
