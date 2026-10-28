-- 0035_entity_card_template.up.sql — заготовка карточки у типа (0.85.0, docs/entity-types.md §4).
--
-- Тип описывает КЛАСС («Фракция»), а заготовка — что подставить в форму новой карточки этого
-- класса: типичное описание с подстановкой {{name}} и набор алиасов. Одна колонка вместо новой
-- сущности «шаблон карточки»: шаблон без типа не имеет смысла, а тип без шаблона — норма.
--
-- Пустой объект, а не NULL: «заготовки нет» и «карточка без описания» — разные вещи, но в
-- интерфейсе обе означают одно — пустое поле. NOT NULL избавляет каждое чтение от проверки.
ALTER TABLE project_entity_types
  ADD COLUMN IF NOT EXISTS card_template jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Форма — объект. Массив или число здесь означали бы ошибку клиента, и лучше узнать о ней на
-- записи, чем на чтении при отрисовке формы.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'project_entity_types_card_template_object'
  ) THEN
    ALTER TABLE project_entity_types
      ADD CONSTRAINT project_entity_types_card_template_object
      CHECK (jsonb_typeof(card_template) = 'object');
  END IF;
END $$;
