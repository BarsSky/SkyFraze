-- 0035_entity_card_template.down.sql
--
-- Заготовку карточки удаляем вместе с колонкой: это настройка типа, а не данные человека —
-- карточки не трогаем, их описания остаются как есть.
ALTER TABLE project_entity_types
  DROP CONSTRAINT IF EXISTS project_entity_types_card_template_object;

ALTER TABLE project_entity_types
  DROP COLUMN IF EXISTS card_template;
