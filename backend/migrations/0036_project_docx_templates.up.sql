-- 0036_project_docx_templates.up.sql — шаблоны оформления DOCX (0.91.0, docs/docx-template.md).
--
-- Автор отдаёт рукопись редактору в Word, и ему нужно СВОЁ оформление: титул, колонтитулы, поля,
-- стили заголовков. Шаблон — это загруженный .docx, в который вставляется текст проекта на место
-- плейсхолдера {{content}}. Шаблонов у проекта может быть несколько («рукопись», «самиздат»), и
-- один из них активен: он и используется при скачивании.
--
-- Строка хранит не только файл, но и РЕЗУЛЬТАТ разбора (стили, плейсхолдер, поля страницы, отчёт):
-- отчёт показывается человеку, а карта стилей нужна выгрузке — разбирать zip на каждой скачке
-- было бы дорого и давало бы разное поведение между загрузкой и выгрузкой.
CREATE TABLE IF NOT EXISTS project_docx_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Имя видит человек: «рукопись», «самиздат». В пределах проекта уникально.
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  -- Файл в хранилище: свой ключ, а не вложение кадра (шаблон не часть книги и не в архиве проекта).
  s3_key      text NOT NULL,
  filename    text NOT NULL,
  size        bigint NOT NULL CHECK (size > 0),
  -- Разбор: [{id,name,type,builtin}], {found,paragraph_style_id,body_ppr_xml,text}, поля страницы,
  -- отчёт с картой стилей и предупреждениями.
  styles      jsonb NOT NULL DEFAULT '[]'::jsonb,
  placeholder jsonb NOT NULL DEFAULT '{}'::jsonb,
  page        jsonb NOT NULL DEFAULT '{}'::jsonb,
  report      jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active   boolean NOT NULL DEFAULT false,
  uploaded_by uuid REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS project_docx_templates_name_idx
  ON project_docx_templates (project_id, lower(btrim(name)));

-- Активный шаблон один: частичный уникальный индекс. Выгрузка не должна гадать, какой брать.
CREATE UNIQUE INDEX IF NOT EXISTS project_docx_templates_active_idx
  ON project_docx_templates (project_id) WHERE is_active;
