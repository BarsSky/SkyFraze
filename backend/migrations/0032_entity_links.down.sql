-- 0032: откат связей между карточками.
DROP INDEX IF EXISTS project_entity_links_project_idx;
DROP INDEX IF EXISTS project_entity_links_to_idx;
DROP INDEX IF EXISTS project_entity_links_from_idx;
DROP INDEX IF EXISTS project_entity_links_uniq_idx;
DROP TABLE IF EXISTS project_entity_links;
