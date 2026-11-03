DROP INDEX IF EXISTS ai_knowledge_tags_gin;
DROP INDEX IF EXISTS ai_knowledge_summary_trgm;
DROP INDEX IF EXISTS ai_knowledge_title_trgm;
ALTER TABLE ai_knowledge DROP COLUMN IF EXISTS tags;
-- Расширение pg_trgm не удаляем: оно не принадлежит только знаниям, и удаление сломало бы
-- любую будущую индексацию по триграммам.
