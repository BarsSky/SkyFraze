-- 0046: поиск по знаниям и теги (0.152.0).
--
-- Зачем pg_trgm. `ILIKE` находит только точное вхождение: «дракон» → «драконы» да, а
-- «драконами» уже нет, и порядок результатов не отличается — список шёл по дате, поэтому
-- самое подходящее знание могло оказаться последним. Триграммы дают и нечёткий поиск, и
-- оценку похожести для ранжирования, без внешнего поисковика и без словаря морфологии.
--
-- Зачем теги. Морфологию триграммы не решают («драконами» и «драконы» дают мало общего), а
-- словарь/лемматизатор — это ещё одна зависимость и язык. Короткие метки (1–5 на знание)
-- закрывают этот разрыв: модель ставит их при сохранении, человек может поправить.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE ai_knowledge
  ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';

-- Индексы для нечёткого поиска: без них similarity считался бы по всем строкам проекта.
CREATE INDEX IF NOT EXISTS ai_knowledge_title_trgm
  ON ai_knowledge USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS ai_knowledge_summary_trgm
  ON ai_knowledge USING gin (summary gin_trgm_ops);

CREATE INDEX IF NOT EXISTS ai_knowledge_tags_gin
  ON ai_knowledge USING gin (tags);
