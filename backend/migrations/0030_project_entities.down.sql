-- 0030: откат карточек сущностей.
DROP INDEX IF EXISTS project_entities_list_idx;
DROP INDEX IF EXISTS project_entities_name_idx;
DROP TABLE IF EXISTS project_entities;
