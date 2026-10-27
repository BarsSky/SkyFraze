-- 0034 (откат): свои типы карточек.
-- ВНИМАНИЕ: откат уносит классификацию. Карточки с нестандартным видом сначала переводятся в
-- «Тему», иначе CHECK на три значения не даст вернуть старое ограничение.
UPDATE project_entities SET kind = 'theme'
 WHERE kind NOT IN ('character', 'place', 'theme');


ALTER TABLE project_entities DROP CONSTRAINT IF EXISTS project_entities_kind_fk;

ALTER TABLE project_entities
    ADD CONSTRAINT project_entities_kind_check CHECK (kind IN ('character', 'place', 'theme'));

DROP TABLE IF EXISTS project_entity_types;
